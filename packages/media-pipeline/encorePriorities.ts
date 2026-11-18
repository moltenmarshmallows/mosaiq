/**
 * Encore job priorities → Redis priority queues.
 *
 * With `encore-settings.concurrency: 2` (Compose default) the two queues are
 * used as *capability classes*, not just priority classes:
 *   priority 50–100 → queue 0 — GPU class (only GPU workers poll it)
 *   priority 0–49   → queue 1 — CPU class (all workers poll it)
 *
 * A worker that detects a GPU polls queue 1 with `poll-higher-prio` so it
 * drains GPU-class jobs first, then CPU jobs. A CPU-only worker polls queue 1
 * with `poll-higher-prio: false` and can never pick up a GPU job.
 *
 * The submitter picks the priority class to match the chosen profile variant:
 * `-gpu-*` profiles must land in queue 0 or a CPU worker could run them and
 * fail. CPU-profile fallbacks stay under 50 (still above ladder work).
 *
 * Docs: https://svt.github.io/encore/deployment/#priority-to-queue-mapping
 */

export type EncoreBackendClass = 'gpu' | 'cpu';

export const ENCORE_JOB_PRIORITY = {
  /** Fast-lane 720p preview encode — GPU class when a GPU worker is live. */
  FAST_LANE_720P_GPU: 80,
  /** Fast-lane 720p on CPU — queue 1, still ahead of ladder/podcast. */
  FAST_LANE_720P_CPU: 49,
  /** Full ABR ladder on GPU (queue 0, below fast-lane previews). */
  FULL_LADDER_GPU: 70,
  /** Full ABR ladder on CPU (queue 1). */
  FULL_LADDER_CPU: 30,
  /** Podcast MP3 sidecar — CPU class (audio encode, no GPU benefit). */
  PODCAST: 20,
  /** Short podcast preview MP3 — CPU class. */
  PREVIEW_MP3: 25,
} as const;

/** Priority for a job class given the resolved encode backend. */
export function encorePriorityFor(
  kind: 'fast_lane' | 'full_ladder' | 'podcast' | 'preview_mp3',
  backend: EncoreBackendClass,
): number {
  if (kind === 'fast_lane') {
    return backend === 'gpu'
      ? ENCORE_JOB_PRIORITY.FAST_LANE_720P_GPU
      : ENCORE_JOB_PRIORITY.FAST_LANE_720P_CPU;
  }
  if (kind === 'full_ladder') {
    return backend === 'gpu'
      ? ENCORE_JOB_PRIORITY.FULL_LADDER_GPU
      : ENCORE_JOB_PRIORITY.FULL_LADDER_CPU;
  }
  if (kind === 'podcast') return ENCORE_JOB_PRIORITY.PODCAST;
  return ENCORE_JOB_PRIORITY.PREVIEW_MP3;
}

/** Queue index for a job priority when concurrency === 2. */
export function encoreQueueForPriority(priority: number, concurrency = 2): number {
  if (concurrency !== 2) {
    throw new Error(`encoreQueueForPriority only models concurrency=2 (got ${concurrency})`);
  }
  return priority >= 50 ? 0 : 1;
}
