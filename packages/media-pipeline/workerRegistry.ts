/**
 * Encode-worker capability registry, backed by Redis (shared with Encore).
 *
 * Workers POST heartbeats to the supervisor (`/api/workers/heartbeat`), which
 * stores one TTL'd key per worker. The pipeline reads the registry to pick
 * `-gpu-*` Encore profile variants only when a live worker actually reports
 * that backend — Encore routes jobs by priority class, not capability, so
 * profile choice is the only place capability can be honored.
 *
 * `VMP_WORKER_REGISTRY_MEMORY_ONLY=1` disables Redis (tests).
 */

import { createClient } from 'redis';

export type WorkerGpuBackend = 'nvenc' | 'vaapi' | 'cpu';

export type WorkerRecord = {
  workerId: string;
  hostname: string;
  gpuBackend: WorkerGpuBackend;
  /** Encore poll queue the worker is pinned to. */
  pollQueue: number;
  /** Worker image / entrypoint version tag, free-form. */
  version?: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

const REDIS_KEY_PREFIX = 'vmp:worker:';
const WORKER_TTL_SEC = Math.max(
  30,
  Number.parseInt(process.env.VMP_WORKER_TTL_SEC || '120', 10) || 120,
);

/** Concrete client type from default createClient() (RESP3 in redis@6). */
type RegistryRedisClient = ReturnType<typeof createRegistryClient>;

function createRegistryClient() {
  return createClient({
    url: (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim(),
    socket: {
      connectTimeout: 1500,
      // No internal reconnect loop — connect() must reject promptly so the
      // caller can fall back to memory and retry after REDIS_RETRY_COOLDOWN_MS.
      reconnectStrategy: () => false,
    },
  });
}

let redisClient: RegistryRedisClient | null = null;
let redisConnectPromise: Promise<RegistryRedisClient | null> | null = null;
// Retry a failed Redis connect after a cooldown instead of latching memory-only.
let redisRetryAfterMs = 0;
const REDIS_RETRY_COOLDOWN_MS = 30_000;

const memoryWorkers = new Map<string, WorkerRecord & { expiresAtMs: number }>();

async function getRedis(): Promise<RegistryRedisClient | null> {
  if (
    Date.now() < redisRetryAfterMs ||
    process.env.VMP_WORKER_REGISTRY_MEMORY_ONLY === '1'
  ) {
    return null;
  }
  if (redisClient?.isOpen) return redisClient;
  if (redisConnectPromise) return redisConnectPromise;

  redisConnectPromise = (async () => {
    try {
      const client = createRegistryClient();
      client.on('error', (err) => {
        process.stderr.write(
          `[worker-registry] redis error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
      await client.connect();
      redisClient = client;
      return client;
    } catch (err) {
      process.stderr.write(
        `[worker-registry] redis unavailable, memory-only: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      redisRetryAfterMs = Date.now() + REDIS_RETRY_COOLDOWN_MS;
      return null;
    } finally {
      redisConnectPromise = null;
    }
  })();

  return redisConnectPromise;
}

export function isWorkerAlive(record: WorkerRecord, nowMs = Date.now()): boolean {
  const seen = Date.parse(record.lastSeenAt);
  return Number.isFinite(seen) && nowMs - seen < WORKER_TTL_SEC * 1000;
}

export async function recordWorkerHeartbeat(
  worker: Omit<WorkerRecord, 'firstSeenAt' | 'lastSeenAt'>,
): Promise<WorkerRecord> {
  const now = new Date();
  const existing = memoryWorkers.get(worker.workerId);
  const record: WorkerRecord = {
    ...worker,
    firstSeenAt: existing?.firstSeenAt ?? now.toISOString(),
    lastSeenAt: now.toISOString(),
  };
  memoryWorkers.set(worker.workerId, {
    ...record,
    expiresAtMs: now.getTime() + WORKER_TTL_SEC * 1000,
  });
  const client = await getRedis();
  if (client) {
    try {
      const raw = await client.get(`${REDIS_KEY_PREFIX}${worker.workerId}`);
      if (raw) {
        const prev = JSON.parse(String(raw)) as Partial<WorkerRecord>;
        if (prev?.firstSeenAt) record.firstSeenAt = String(prev.firstSeenAt);
      }
      memoryWorkers.set(worker.workerId, {
        ...record,
        expiresAtMs: now.getTime() + WORKER_TTL_SEC * 1000,
      });
      await client.set(`${REDIS_KEY_PREFIX}${worker.workerId}`, JSON.stringify(record), {
        EX: WORKER_TTL_SEC,
      });
    } catch (err) {
      process.stderr.write(
        `[worker-registry] persist failed ${worker.workerId}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return record;
}

export async function listWorkers(): Promise<WorkerRecord[]> {
  const nowMs = Date.now();
  const seen = new Map<string, WorkerRecord>();
  const client = await getRedis();
  if (client) {
    try {
      for await (const keys of client.scanIterator({ MATCH: `${REDIS_KEY_PREFIX}*`, COUNT: 100 })) {
        for (const key of keys) {
          const raw = await client.get(String(key));
          if (!raw) continue;
          const record = JSON.parse(String(raw)) as WorkerRecord;
          if (record?.workerId) seen.set(record.workerId, record);
        }
      }
    } catch {
      /* fall through to memory */
    }
  }
  for (const [id, record] of memoryWorkers) {
    if (record.expiresAtMs <= nowMs) {
      memoryWorkers.delete(id);
      continue;
    }
    const existing = seen.get(id);
    // Keep whichever record heartbeated most recently — a stale Redis copy
    // must not mask a newer in-memory profile (and vice versa).
    if (!existing || Date.parse(record.lastSeenAt) > Date.parse(existing.lastSeenAt)) {
      seen.set(id, record);
    }
  }
  return [...seen.values()].filter((r) => isWorkerAlive(r, nowMs));
}

/** Redis reachability for /metrics + health reporting. */
export async function redisHealthy(): Promise<boolean> {
  const client = await getRedis();
  if (!client) return false;
  try {
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}

/** GPU backends offered by at least one live worker. */
export async function liveWorkerBackends(): Promise<Set<WorkerGpuBackend>> {
  const backends = new Set<WorkerGpuBackend>();
  for (const worker of await listWorkers()) {
    backends.add(worker.gpuBackend);
  }
  return backends;
}

/** Live GPU-capable worker counts per backend (cpu excluded). */
export async function liveWorkerBackendCounts(): Promise<Map<WorkerGpuBackend, number>> {
  const counts = new Map<WorkerGpuBackend, number>();
  for (const worker of await listWorkers()) {
    if (worker.gpuBackend === 'cpu') continue;
    counts.set(worker.gpuBackend, (counts.get(worker.gpuBackend) ?? 0) + 1);
  }
  return counts;
}

/** Test helper — reset in-memory + redis client state. */
export async function _resetWorkerRegistryForTests(): Promise<void> {
  memoryWorkers.clear();
  redisRetryAfterMs = 0;
  if (redisClient?.isOpen) {
    try {
      await redisClient.quit();
    } catch {
      /* ignore */
    }
  }
  redisClient = null;
  redisConnectPromise = null;
}
