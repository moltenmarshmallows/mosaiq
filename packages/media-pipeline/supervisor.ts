#!/usr/bin/env node

/**
 * VMP media host supervisor: runs pipeline_watch.js, serves local dashboard + webhook API.
 *
 * Environment:
 *   VMP_WEBHOOK_SECRET     — HMAC secret (same as admin_settings); required unless VMP_REQUIRE_WEBHOOK_SECRET=0
 *   VMP_SUPERVISOR_DASHBOARD_SECRET — protects dashboard + job control (required when VMP_UI_HOST is not loopback)
 *   VMP_UI_HOST            — default 127.0.0.1
 *   VMP_UI_PORT            — default 8788
 *   VMP_PIPELINE_SCRIPT    — default: pipeline_watch.js next to this file
 *   VMP_RENDER_SCRIPT      — path to render script; default: render_podcast_preview_mp3.js next to this file
 *   VMP_RUN_PIPELINE       — default 1; set 0 to only run UI + preview jobs (no watchfolder)
 *   VMP_PREVIEW_CONCURRENCY — max concurrent preview encodes (default 1)
 *
 * Systemd: one unit runs this process; it spawns the Node pipeline watcher as a child.
 */

import type { ChildProcess } from 'node:child_process';
import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAggregateEncoreJobDoc } from './encoreAggregate.js';
import { getEncoreJob } from './encoreClient.js';
import { IngestPlanError, planIngest } from './ingestSource.js';
import { gauge, increment } from './metrics.js';
import { rewriteEncoreJobUrlForPackager } from './packagerEncoreUrl.js';
import { enqueuePackagerJob } from './packagingQueue.js';
import {
  getPackagingJob,
  listPackagingJobs,
  markPackagingFailed,
  markPackagingSuccess,
  registerPackagingJob,
} from './packagingRegistry.js';
import { formatDoctorReport, runPipelineDoctor } from './pipelineDoctor.js';
import {
  extractBasicAuthPassword,
  isLoopbackHost,
  REBUILD_WEBHOOK_PATHS,
  requiresDashboardAuth,
  resolvePackagerCallbackJobId,
  verifyDashboardSecret,
  verifyPackagerCallbackSecret,
} from './supervisorAuth.js';
import { planTusIntake, tusdDataDir } from './tusIntake.js';
import {
  listWorkers,
  recordWorkerHeartbeat,
  redisHealthy,
  type WorkerGpuBackend,
} from './workerRegistry.js';
import { writeObjectBodyToFile } from './writeObjectBodyToFile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = __dirname;

const pipelineScript = process.env.VMP_PIPELINE_SCRIPT || path.join(pkgRoot, 'pipeline_watch.js');
const renderScript =
  process.env.VMP_RENDER_SCRIPT || path.join(pkgRoot, 'render_podcast_preview_mp3.js');

const requireWebhookSecret = process.env.VMP_REQUIRE_WEBHOOK_SECRET !== '0';
const secret = process.env.VMP_WEBHOOK_SECRET?.trim();
const packagingSecret = (process.env.VMP_PACKAGING_SECRET || secret || '').trim();
if (requireWebhookSecret && !secret) {
  console.error('[media-pipeline] Set VMP_WEBHOOK_SECRET or VMP_REQUIRE_WEBHOOK_SECRET=0');
  process.exit(1);
}

const packagerSecret = process.env.VMP_PACKAGER_SECRET?.trim();
if (!packagerSecret) {
  console.error('[media-pipeline] Set VMP_PACKAGER_SECRET for packager callback security');
  process.exit(1);
}

/** Worker heartbeat auth — dedicated token, falls back to the packaging secret. */
const workerToken = (
  process.env.VMP_WORKER_TOKEN ||
  process.env.VMP_PACKAGING_SECRET ||
  packagingSecret
).trim();
const ENCORE_BASE = (process.env.ENCORE_BASE_URL || 'http://127.0.0.1:8080')
  .trim()
  .replace(/\/+$/, '');
const TUSD_URL = (process.env.TUSD_URL || 'http://tusd:1080').trim().replace(/\/+$/, '');
/** API origin ingest fetch URLs are allowed to point at (SSRF allowlist). */
const apiBaseUrl = (process.env.VMP_API_BASE_URL || '').trim().replace(/\/+$/, '');
const WORKER_BACKENDS = new Set<WorkerGpuBackend>(['nvenc', 'vaapi', 'cpu']);

const uiHost = process.env.VMP_UI_HOST || '127.0.0.1';
const uiPort = Number.parseInt(process.env.VMP_UI_PORT || '8788', 10);
const dashboardSecret = (process.env.VMP_SUPERVISOR_DASHBOARD_SECRET || '').trim();
if (!isLoopbackHost(uiHost) && !dashboardSecret) {
  console.error(
    '[media-pipeline] VMP_SUPERVISOR_DASHBOARD_SECRET is required when VMP_UI_HOST is not loopback (current: ' +
      `${uiHost}). Webhooks stay public with HMAC; set a dashboard secret for /api/status and job control.`,
  );
  process.exit(1);
}
const runPipeline = process.env.VMP_RUN_PIPELINE !== '0';
const MAX_GPU_JOBS = Math.max(1, Number.parseInt(process.env.VMP_GPU_CONCURRENCY || '1', 10) || 1);
const MAX_UPLOAD_JOBS = Math.max(
  1,
  Number.parseInt(process.env.VMP_UPLOAD_CONCURRENCY || '2', 10) || 2,
);
const STUCK_JOB_MINUTES = Math.max(
  1,
  Number.parseInt(process.env.VMP_STUCK_JOB_MINUTES || '60', 10) || 60,
);
const gpuSlots = { max: MAX_GPU_JOBS, current: 0 };
const uploadSlots = { max: MAX_UPLOAD_JOBS, current: 0 };
let previewGpuRunning = 0;
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const autoUpgradeEnabled = process.env.VMP_AUTO_UPGRADE === '1';
const autoUpgradeBranch = process.env.VMP_AUTO_UPGRADE_BRANCH || 'main';
const autoUpgradeRepoDir = process.env.VMP_AUTO_UPGRADE_REPO_DIR || '/workspace';
const autoUpgradePath = process.env.VMP_AUTO_UPGRADE_PATH || 'packages/media-pipeline';
const autoUpgradeCheckMs = Math.max(
  60_000,
  Number.parseInt(process.env.VMP_AUTO_UPGRADE_CHECK_MS || '300000', 10) || 300000,
);

function validateScriptPath(rawPath, label, envVarName, defaultScriptName) {
  const resolved = path.resolve(rawPath);
  const basename = path.basename(resolved);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `${label} script not found at ${resolved}. ` +
        `Update ${envVarName} to a valid .js script path.`,
    );
  }
  if (basename.endsWith('.sh')) {
    throw new Error(
      `${label} script points to deprecated shell script ${resolved}. ` +
        `Use the Node script (${defaultScriptName}) instead.`,
    );
  }
  if (basename.endsWith('.ts')) {
    const distDir = path.join(path.dirname(resolved), 'dist');
    throw new Error(
      `${label} script points to TypeScript source ${resolved}. ` +
        `Node imports use .js paths (e.g. ttpLog.js) that exist only in dist/ after build. ` +
        `Run \`npm run build --workspace=@vmp/media-pipeline\`, then set ${envVarName} to ` +
        `${path.join(distDir, defaultScriptName)} or remove the override.`,
    );
  }
  return resolved;
}

/** Ensure compiled pipeline_watch.js sibling imports (e.g. ttpLog.js) exist after git pull. */
function validatePipelineBundle(resolvedPipelineScript) {
  const dir = path.dirname(resolvedPipelineScript);
  const content = fs.readFileSync(resolvedPipelineScript, 'utf8');
  const importRe = /from\s+['"]\.\/([^'"]+\.js)['"]/g;
  const missing = [];
  for (const match of content.matchAll(importRe)) {
    const depPath = path.join(dir, match[1]);
    if (!fs.existsSync(depPath)) missing.push(match[1]);
  }
  if (missing.length === 0) return;
  throw new Error(
    `Pipeline script ${resolvedPipelineScript} imports missing module(s): ${missing.join(', ')}. ` +
      'dist/ is not committed — run `npm run build --workspace=@vmp/media-pipeline` after pulling changes.',
  );
}

let resolvedPipelineScript = pipelineScript;
let resolvedRenderScript = renderScript;
try {
  resolvedPipelineScript = validateScriptPath(
    pipelineScript,
    'Pipeline',
    'VMP_PIPELINE_SCRIPT',
    'pipeline_watch.js',
  );
  validatePipelineBundle(resolvedPipelineScript);
  resolvedRenderScript = validateScriptPath(
    renderScript,
    'Render',
    'VMP_RENDER_SCRIPT',
    'render_podcast_preview_mp3.js',
  );
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[media-pipeline] ${message}`);
  console.error(
    '[media-pipeline] Migration note: legacy .sh scripts were removed; update env overrides to the new .js entrypoints.',
  );
  process.exit(1);
}

type QueuedJob = {
  id: string;
  type: 'pipeline' | 'preview_mp3';
  videoId: string;
  priority: number;
  enqueuedAt: string;
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'stopped';
  detail?: string;
  source?: string;
  previewSeconds?: number;
};

/** @type {QueuedJob[]} */
const jobQueue: QueuedJob[] = [];
/** @type {Map<string, QueuedJob>} */
const jobsById = new Map<string, QueuedJob>();
/** @type {Map<string, QueuedJob>} */
const jobsByVideoId = new Map<string, QueuedJob>();

function jobRegistryKey(type: QueuedJob['type'], videoId: string): string {
  return `${type}:${videoId}`;
}

function getQueuedJob(type: QueuedJob['type'], videoId: string): QueuedJob | undefined {
  return jobsByVideoId.get(jobRegistryKey(type, videoId));
}
/** @type {Map<string, { id: string, type: string, videoId: string, source: string, stage: string, status: string, detail?: string, startedAt: string, updatedAt: string, finishedAt?: string }>} */
const pipelineActiveJobs = new Map();
/** @type {{ id: string, type: string, videoId: string, source: string, stage: string, status: string, detail?: string, startedAt: string, updatedAt: string, finishedAt: string }[]} */
const pipelineSuccessfulJobs = [];
const MAX_PIPELINE_SUCCESS_JOBS = 400;
/** @type {{ id: string, type: string, videoId: string, source: string, stage: string, status: string, detail?: string, startedAt: string, updatedAt: string, finishedAt: string }[]} */
const failedPipelineJobs = [];
const MAX_PIPELINE_FAILED_JOBS = 200;
/** @type {string[]} */
const logLines = [];
const MAX_LOG = 400;
/** @type {{ videoId: string, minimalMs: number|null, fullMs: number|null, totalMs: number, minimalRatio: number|null, fullRatio: number|null, at: string }[]} */
const ttpSummaries = [];
const MAX_TTP_SUMMARIES = 50;

function pushLog(line) {
  const ts = new Date().toISOString();
  const s = `[${ts}] ${line}`;
  console.log(s);
  logLines.push(s);
  while (logLines.length > MAX_LOG) logLines.shift();
}

const STAGE_LABELS: Record<string, string> = {
  detected: 'Detected in watchfolder',
  deduped: 'Already processing',
  wait_upload_complete: 'Waiting for file settle',
  probe: 'Probe source',
  phase1_encode: 'Phase 1: encode & package 720p',
  phase1_upload: 'Phase 1: upload 720p to R2',
  phase1_available: 'Phase 1: 720p watchable',
  phase2_encode: 'Phase 2: encode 1080p & 480p',
  phase2_package: 'Phase 2: package multi-rendition HLS',
  phase2_upload: 'Phase 2: upload renditions to R2',
  phase2_manifest_swap: 'Phase 2: swap master manifest',
  multi_rendition_ready: 'All renditions ready',
  encode: 'Re-encoding renditions',
  podcast_mp3: 'Encoding podcast MP3',
  package_hls: 'Packaging HLS',
  upload_assets: 'Uploading assets to R2',
  preview_wait: 'Waiting preview lock',
  preview_render: 'Encoding preview MP3',
  preview_upload: 'Uploading preview MP3',
  cleanup: 'Cleanup',
  done: 'Done',
  failed: 'Failed',
  paused: 'Paused',
  resumed: 'Resumed',
  stopped: 'Stopped',
};

function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage;
}

function sortJobQueue(): void {
  jobQueue.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.enqueuedAt < b.enqueuedAt ? -1 : a.enqueuedAt > b.enqueuedAt ? 1 : 0;
  });
}

function registerQueuedJob(job: QueuedJob): void {
  jobsById.set(job.id, job);
  jobsByVideoId.set(jobRegistryKey(job.type, job.videoId), job);
  const existingIdx = jobQueue.findIndex((q) => q.id === job.id);
  if (existingIdx >= 0) jobQueue[existingIdx] = job;
  else jobQueue.push(job);
  sortJobQueue();
  while (jobQueue.length > 200) {
    const removed = jobQueue.pop();
    if (removed) {
      jobsById.delete(removed.id);
      jobsByVideoId.delete(jobRegistryKey(removed.type, removed.videoId));
    }
  }
}

function getQueuePosition(videoId: string): number | null {
  const idx = jobQueue.findIndex((j) => j.videoId === videoId && j.status === 'queued');
  return idx >= 0 ? idx + 1 : null;
}

function isEncodeStage(stage: string): boolean {
  return /encode|podcast_mp3|preview_render|probe/.test(stage);
}

function isUploadStage(stage: string): boolean {
  return /upload/.test(stage);
}

function syncResourceSlots(): void {
  let gpu = previewGpuRunning;
  let upload = 0;
  for (const job of pipelineActiveJobs.values()) {
    if (job.status === 'paused') continue;
    const stage = String(job.stage || '');
    if (isEncodeStage(stage)) gpu += 1;
    if (isUploadStage(stage)) upload += 1;
  }
  gpuSlots.current = gpu;
  uploadSlots.current = upload;
  reportSupervisorMetrics();
}

function reportSupervisorMetrics(): void {
  const previewQueued = jobQueue.filter(
    (j) => j.type === 'preview_mp3' && j.status === 'queued',
  ).length;
  gauge('vmp.supervisor.preview_queue.depth', previewQueued);
  gauge('vmp.supervisor.gpu_slots.used', gpuSlots.current);
  gauge('vmp.supervisor.upload_slots.used', uploadSlots.current);
  gauge('vmp.supervisor.pipeline_child.alive', pipelineChild && !pipelineState.exited ? 1 : 0);
}

function phaseProgressFromOverall(overall: number | null) {
  if (overall == null || !Number.isFinite(overall)) {
    return { phase1Pct: null, phase2Pct: null, phase2Started: false };
  }
  const clamped = Math.max(0, Math.min(1, overall));
  const phase1Pct = Math.min(1, clamped / 0.3);
  const phase2Started = clamped > 0.3;
  const phase2Pct = phase2Started ? Math.min(1, (clamped - 0.3) / 0.5) : 0;
  return { phase1Pct, phase2Pct, phase2Started };
}

function upsertPipelineJob(event) {
  const now = new Date().toISOString();
  const existing = pipelineActiveJobs.get(event.videoId);
  const startedAt = existing?.startedAt || now;
  const row = {
    id: existing?.id || crypto.randomUUID(),
    type: 'pipeline',
    videoId: event.videoId,
    source: existing?.source || event.source || 'watchfolder',
    stage: event.stage,
    status: event.status,
    detail: event.detail,
    startedAt,
    updatedAt: now,
    finishedAt: undefined,
    progressOverall: existing?.progressOverall ?? null,
    progressStage: existing?.progressStage ?? event.stage,
    progressRendition: existing?.progressRendition ?? '',
    progressStagePct: existing?.progressStagePct ?? null,
    progressSpeed: existing?.progressSpeed ?? null,
    progressEtaSec: existing?.progressEtaSec ?? null,
    progressPhase: existing?.progressPhase ?? '',
    progressPhase1Pct: existing?.progressPhase1Pct ?? null,
    progressPhase2Pct: existing?.progressPhase2Pct ?? null,
    progressPhase2Started: existing?.progressPhase2Started ?? false,
    priority: existing?.priority ?? 100,
    queuePosition: null,
  };
  let queued = getQueuedJob('pipeline', event.videoId);
  if (!queued && event.stage === 'detected') {
    queued = {
      id: row.id,
      type: 'pipeline',
      videoId: event.videoId,
      priority: 100,
      enqueuedAt: now,
      status: 'running',
      detail: event.detail,
      source: row.source,
    };
    registerQueuedJob(queued);
  }
  if (queued) {
    row.priority = queued.priority;
    if (event.stage === 'paused' || event.status === 'paused') queued.status = 'paused';
    else if (event.stage === 'resumed') queued.status = 'running';
    else if (event.stage === 'stopped' || event.detail === 'stopped_by_user')
      queued.status = 'stopped';
    else if (event.stage === 'done' && event.status === 'success') queued.status = 'done';
    else if (event.stage === 'failed' || event.status === 'failed') queued.status = 'failed';
    else if (!['done', 'failed', 'stopped'].includes(queued.status)) queued.status = 'running';
    registerQueuedJob(queued);
  }
  if (event.stage === 'done' && event.status === 'success') {
    pipelineActiveJobs.delete(event.videoId);
    const doneRow = { ...row, finishedAt: now };
    pipelineSuccessfulJobs.unshift(doneRow);
    while (pipelineSuccessfulJobs.length > MAX_PIPELINE_SUCCESS_JOBS) pipelineSuccessfulJobs.pop();
    syncResourceSlots();
    return;
  }
  if (event.stage === 'failed' || event.status === 'failed' || event.stage === 'stopped') {
    row.finishedAt = now;
    pipelineActiveJobs.delete(event.videoId);
    failedPipelineJobs.unshift(row);
    while (failedPipelineJobs.length > MAX_PIPELINE_FAILED_JOBS) failedPipelineJobs.pop();
    syncResourceSlots();
    return;
  }
  row.queuePosition = getQueuePosition(event.videoId);
  pipelineActiveJobs.set(event.videoId, row);
  syncResourceSlots();
}

function consumeTtpLine(line) {
  if (!line.startsWith('VMP_TTP\t')) return false;
  try {
    const row = JSON.parse(line.slice('VMP_TTP\t'.length));
    if (row.type !== 'ttp_summary') return true;
    ttpSummaries.unshift({
      videoId: String(row.videoId || ''),
      minimalMs: row.minimalPublishReadyElapsedMs ?? null,
      fullMs: row.fullRenditionsReadyElapsedMs ?? null,
      totalMs: row.totalElapsedMs ?? 0,
      minimalRatio: row.minimalPublishReadyRatioOfSourceDuration ?? null,
      fullRatio: row.fullRenditionsReadyRatioOfSourceDuration ?? null,
      at: String(row.at || new Date().toISOString()),
    });
    while (ttpSummaries.length > MAX_TTP_SUMMARIES) ttpSummaries.pop();
  } catch {
    // ignore malformed TTP JSON
  }
  return true;
}

function consumePipelineProgressLine(line) {
  if (!line.startsWith('VMP_PIPELINE_PROGRESS\t')) return false;
  try {
    const row = JSON.parse(line.slice('VMP_PIPELINE_PROGRESS\t'.length));
    const videoId = String(row.videoId || '');
    if (!videoId) return true;
    const existing = pipelineActiveJobs.get(videoId);
    const now = new Date().toISOString();
    const base = existing || {
      id: crypto.randomUUID(),
      type: 'pipeline',
      videoId,
      source: 'watchfolder',
      stage: String(row.stage || 'detected'),
      status: 'active',
      detail: '',
      startedAt: now,
      updatedAt: now,
    };
    const phaseProgress = phaseProgressFromOverall(
      typeof row.overallProgress === 'number' ? row.overallProgress : base.progressOverall,
    );
    pipelineActiveJobs.set(videoId, {
      ...base,
      stage: String(row.stage || base.stage),
      progressOverall:
        typeof row.overallProgress === 'number' ? row.overallProgress : base.progressOverall,
      progressStage: String(row.stage || base.progressStage || ''),
      progressRendition: String(row.rendition || base.progressRendition || ''),
      progressStagePct:
        typeof row.stageProgress === 'number' ? row.stageProgress : base.progressStagePct,
      progressSpeed: typeof row.speed === 'number' ? row.speed : base.progressSpeed,
      progressEtaSec: typeof row.etaSec === 'number' ? row.etaSec : base.progressEtaSec,
      progressPhase: String(row.phase || base.progressPhase || ''),
      progressPhase1Pct: phaseProgress.phase1Pct,
      progressPhase2Pct: phaseProgress.phase2Pct,
      progressPhase2Started: phaseProgress.phase2Started,
      detail: row.detail ? String(row.detail) : base.detail,
      updatedAt: now,
      priority: getQueuedJob('pipeline', videoId)?.priority ?? 100,
      queuePosition: getQueuePosition(videoId),
    });
    syncResourceSlots();
  } catch {
    // ignore malformed progress JSON
  }
  return true;
}

function consumePipelineLine(line) {
  if (!line.startsWith('VMP_PIPELINE_EVENT\t')) return false;
  const parts = line.split('\t', 5);
  if (parts.length < 4) return false;
  const [, videoId, stage, status, detailRaw] = parts;
  if (!videoId || !stage || !status) return false;
  const detail = detailRaw || '';
  const sourceMatch = detail.match(/(?:^|\s)source=([a-zA-Z0-9_.-]+)/);
  upsertPipelineJob({
    videoId,
    stage,
    status,
    detail,
    source: sourceMatch ? sourceMatch[1] : undefined,
  });
  return true;
}

/** @type {{ pid: number|null, startedAt: string|null, exited: boolean, code: number|null, signal: string|null }} */
const pipelineState = {
  pid: null,
  startedAt: null,
  exited: false,
  code: null,
  signal: null,
};

let pipelineChild = null;
let pipelineIpcPath: string | null = null;
let pipelineRestartTimer: ReturnType<typeof setTimeout> | null = null;

function sendPipelineCommand(
  cmd: 'pause' | 'resume' | 'stop' | 'reorder' | 'intake',
  videoId?: string,
  payload?: { order?: string[]; file?: string; inboxDir?: string; pipelineMode?: string },
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!pipelineIpcPath) {
      resolve({ ok: false, error: 'ipc_not_ready' });
      return;
    }
    const client = net.createConnection(pipelineIpcPath);
    const message = JSON.stringify({ cmd, videoId, payload });
    let response = '';
    const finish = (result: { ok: boolean; error?: string }) => {
      try {
        client.destroy();
      } catch {}
      resolve(result);
    };
    client.setTimeout(10_000, () => finish({ ok: false, error: 'timeout' }));
    client.on('connect', () => client.end(message));
    client.on('data', (d) => {
      response += d.toString();
    });
    client.on('end', () => {
      try {
        finish(JSON.parse(response) as { ok: boolean; error?: string });
      } catch {
        finish({ ok: false, error: 'invalid_response' });
      }
    });
    client.on('error', (err) => finish({ ok: false, error: err.message }));
  });
}

/**
 * Publish a completed upload into the inbox: hard link (atomic, never
 * overwrites), then tell the watcher — link() emits no close_write/moved_to
 * event so inotify alone can't see it. On EEXIST the file was already
 * accepted: still send intake so a failed job gets requeued while a
 * queued/running one dedupes inside maybeEnqueueOnce.
 */
type InboxPublishOutcome = 'published' | 'same-file' | 'conflict';

/** destPath → pipelineMode for handoffs the watcher hasn't acknowledged yet. */
const pendingIntakeHandoffs = new Map<string, string>();

async function sendIntakeHandoff(destPath: string, pipelineMode: string): Promise<void> {
  const handoff = await sendPipelineCommand('intake', undefined, {
    file: path.basename(destPath),
    inboxDir: path.dirname(destPath),
    pipelineMode,
  });
  if (handoff.ok) {
    pendingIntakeHandoffs.delete(destPath);
    return;
  }
  // The file IS in the inbox — a watcher restart scan picks it up, and the
  // periodic drain retries meanwhile.
  pendingIntakeHandoffs.set(destPath, pipelineMode);
  pushLog(
    `intake handoff for ${path.basename(destPath)} failed (${handoff.error ?? 'unknown'}) — queued for retry`,
  );
}

function drainPendingIntakeHandoffs(): void {
  for (const [destPath, pipelineMode] of [...pendingIntakeHandoffs]) {
    void sendIntakeHandoff(destPath, pipelineMode);
  }
}

/**
 * Atomically publish srcPath into the inbox without clobbering an existing
 * file. Returns 'published', 'same-file' (retry of an already-published
 * upload — src is the same inode and is removed), or 'conflict' (a different
 * file already owns the name — src is left for the caller to keep or clean).
 */
async function publishToInbox(
  srcPath: string,
  destPath: string,
  pipelineMode: string,
): Promise<InboxPublishOutcome> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  let outcome: InboxPublishOutcome = 'published';
  try {
    await fs.promises.link(srcPath, destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Same inode → src and dest are already the same published file.
    const [srcStat, destStat] = await Promise.all([
      fs.promises.stat(srcPath),
      fs.promises.stat(destPath).catch(() => null),
    ]);
    if (destStat && srcStat.dev === destStat.dev && srcStat.ino === destStat.ino) {
      await fs.promises.rm(srcPath, { force: true });
      outcome = 'same-file';
    } else {
      outcome = 'conflict';
    }
  }
  if (outcome === 'published') await fs.promises.rm(srcPath, { force: true });
  // No handoff on conflict — the existing file is a different upload.
  if (outcome !== 'conflict') {
    await sendIntakeHandoff(destPath, pipelineMode);
  }
  return outcome;
}

/** destPath of ingest requests currently downloading/publishing. */
const ingestInFlight = new Set<string>();

// tusd re-fires post-finish when our hook response is lost; by then publish
// already moved the filestore source, so planTusIntake throws 'upload file
// missing'. Tombstones in .published/ make repeat hooks (and restarts)
// idempotent while 409 stays for a different upload claiming the name.
const TUS_PUBLISHED_DIR_NAME = '.published';
const TUS_PUBLISHED_LIMIT = 4096;

function tusPublishedDir(): string {
  return path.join(tusdDataDir(process.env), TUS_PUBLISHED_DIR_NAME);
}

function tusPublishedPath(uploadId: string): string {
  // Filestore IDs are alnum+hyphen; keep a whitelist anyway since this joins a path.
  return path.join(tusPublishedDir(), uploadId.replace(/[^a-zA-Z0-9_-]/g, '_'));
}

async function tusPublishedDestination(uploadId: string): Promise<string | null> {
  try {
    return (await fs.promises.readFile(tusPublishedPath(uploadId), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function recordTusPublished(uploadId: string, destBasename: string): Promise<void> {
  try {
    const dir = tusPublishedDir();
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tusPublishedPath(uploadId), destBasename, 'utf8');
    // Bound tombstone growth — FIFO sweep of the oldest entries. Stat every
    // entry before choosing victims; slicing readdir's arbitrary order first
    // could spare genuinely-oldest tombstones.
    const entries = (await fs.promises.readdir(dir)).filter((e) => e !== '.' && e !== '..');
    if (entries.length > TUS_PUBLISHED_LIMIT) {
      const stats = (
        await Promise.all(
          entries.map(async (e) => ({
            name: e,
            mtime: (await fs.promises.stat(path.join(dir, e)).catch(() => null))?.mtimeMs ?? 0,
          })),
        )
      ).sort((a, b) => a.mtime - b.mtime);
      for (const s of stats.slice(0, entries.length - TUS_PUBLISHED_LIMIT)) {
        await fs.promises.rm(path.join(dir, s.name), { force: true }).catch(() => {});
      }
    }
  } catch {
    /* a lost tombstone only means a repeat hook re-uses planTusIntake */
  }
}

/**
 * Download + stage + publish an ingest source after the endpoint has already
 * acked 202. A name conflict means a previous delivery already published this
 * video — treat as delivered, not an error.
 */
async function runSourceIngest(plan: ReturnType<typeof planIngest>): Promise<void> {
  // No deadline otherwise: a stalled proxy download would pin ingestInFlight
  // forever and turn every retry of this upload into a deduped no-op.
  const timeoutMs = Math.max(
    30_000,
    Number(process.env.VMP_INGEST_DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000),
  );
  const upstream = await fetch(plan.fetchUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!upstream.ok || !upstream.body) {
    // Release the response body before bailing — never leak the socket.
    await upstream.body?.cancel().catch(() => {});
    throw new Error(`source fetch failed: HTTP ${upstream.status}`);
  }
  // Stage inside the destination inbox (hidden subdir the non-recursive
  // watcher can't see) so link() is guaranteed same-filesystem, then publish
  // atomically — never clobbering a file the watcher accepted.
  const stagingDir = path.join(path.dirname(plan.destPath), '.ingest-staging');
  await fs.promises.mkdir(stagingDir, { recursive: true });
  const staged = path.join(stagingDir, `${plan.destBasename}.${crypto.randomUUID()}`);
  try {
    await writeObjectBodyToFile(upstream.body, staged);
    const outcome = await publishToInbox(staged, plan.destPath, plan.pipelineMode);
    if (outcome === 'conflict') {
      increment('vmp.ingest.conflict', 1, { mode: plan.pipelineMode });
      pushLog(
        `ingest conflict: ${plan.destBasename} — destination already published by a different source; manual reconciliation needed`,
      );
      return;
    }
  } finally {
    // The staging name is unique per request — remove it even when publish
    // left it behind (conflict), but never the inbox file itself.
    await fs.promises.rm(staged, { force: true }).catch(() => {});
  }
  increment('vmp.ingest.accepted', 1, { mode: plan.pipelineMode });
  pushLog(`ingest → ${plan.pipelineMode} inbox: ${plan.destBasename}`);
}

function consumeIpcSocketLine(line: string): boolean {
  if (!line.startsWith('VMP_IPC_SOCKET\t')) return false;
  pipelineIpcPath = line.slice('VMP_IPC_SOCKET\t'.length).trim() || null;
  pushLog(`Pipeline IPC socket: ${pipelineIpcPath ?? '—'}`);
  return true;
}

function markRunningJobsFailedOnPipelineCrash(): void {
  const now = new Date().toISOString();
  for (const job of jobsById.values()) {
    if (job.status === 'running' && job.type === 'pipeline') {
      job.status = 'failed';
      job.detail = 'pipeline_restarted';
      registerQueuedJob(job);
    }
  }
  for (const [videoId, row] of pipelineActiveJobs.entries()) {
    const failedRow = {
      ...row,
      stage: 'failed',
      status: 'failed',
      detail: 'pipeline_restarted',
      finishedAt: now,
    };
    pipelineActiveJobs.delete(videoId);
    failedPipelineJobs.unshift(failedRow);
    while (failedPipelineJobs.length > MAX_PIPELINE_FAILED_JOBS) failedPipelineJobs.pop();
  }
  syncResourceSlots();
}

function startPipeline() {
  if (!runPipeline) {
    pushLog('Pipeline disabled (VMP_RUN_PIPELINE=0)');
    return;
  }
  pipelineChild = spawn(process.execPath, [resolvedPipelineScript], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipelineState.pid = pipelineChild.pid ?? null;
  pipelineState.startedAt = new Date().toISOString();
  pipelineState.exited = false;
  pipelineState.code = null;
  pipelineState.signal = null;
  pushLog(`Started pipeline pid=${pipelineState.pid} (${resolvedPipelineScript})`);

  let stdoutBuffer = '';
  let stderrBuffer = '';

  const processBuffer = (buffer, isStdout) => {
    const lines = buffer.split(/\r?\n/);
    const completeLines = lines.slice(0, -1);
    const partialLine = lines[lines.length - 1];

    for (const line of completeLines) {
      if (!line.trim()) continue;
      if (consumeTtpLine(line)) continue;
      if (consumeIpcSocketLine(line)) continue;
      if (consumePipelineProgressLine(line)) continue;
      if (consumePipelineLine(line)) continue;
      pushLog(`[pipeline] ${line}`);
    }

    return partialLine;
  };

  pipelineChild.stdout?.on('data', (d) => {
    stdoutBuffer += d.toString();
    stdoutBuffer = processBuffer(stdoutBuffer, true);
  });

  pipelineChild.stderr?.on('data', (d) => {
    stderrBuffer += d.toString();
    stderrBuffer = processBuffer(stderrBuffer, false);
  });

  const flushBuffers = () => {
    if (stdoutBuffer.trim()) {
      if (
        consumeTtpLine(stdoutBuffer) ||
        consumeIpcSocketLine(stdoutBuffer) ||
        consumePipelineProgressLine(stdoutBuffer) ||
        consumePipelineLine(stdoutBuffer)
      ) {
        stdoutBuffer = '';
      } else {
        pushLog(`[pipeline] ${stdoutBuffer}`);
        stdoutBuffer = '';
      }
    }
    if (stderrBuffer.trim()) {
      if (
        consumeTtpLine(stderrBuffer) ||
        consumePipelineProgressLine(stderrBuffer) ||
        consumePipelineLine(stderrBuffer)
      ) {
        stderrBuffer = '';
      } else {
        pushLog(`[pipeline] ${stderrBuffer}`);
        stderrBuffer = '';
      }
    }
  };

  pipelineChild.stdout?.on('end', flushBuffers);
  pipelineChild.stderr?.on('end', flushBuffers);

  pipelineChild.on('error', (err) => {
    pushLog(`Pipeline spawn error: ${err.message}`);
  });
  pipelineChild.on('close', (code, signal) => {
    flushBuffers();
    pipelineState.exited = true;
    pipelineState.code = code;
    pipelineState.signal = signal ?? null;
    pushLog(`Pipeline exited code=${code} signal=${signal ?? ''}`);
    pipelineChild = null;
    pipelineState.pid = null;
    pipelineIpcPath = null;
    if (runPipeline) {
      markRunningJobsFailedOnPipelineCrash();
      increment('vmp.supervisor.pipeline.restart', 1);
      pushLog('Pipeline process exited; restarting pipeline_watch in 3s');
      if (pipelineRestartTimer) clearTimeout(pipelineRestartTimer);
      pipelineRestartTimer = setTimeout(() => {
        pipelineRestartTimer = null;
        pipelineState.exited = false;
        pipelineState.code = null;
        pipelineState.signal = null;
        startPipeline();
      }, 3000);
    }
  });
}

const previewChildren = new Set<ChildProcess>();

function enqueuePreview(videoId: string, previewSeconds: number, source = 'webhook'): string {
  const id = crypto.randomUUID();
  const job: QueuedJob = {
    id,
    type: 'preview_mp3',
    videoId,
    priority: 100,
    enqueuedAt: new Date().toISOString(),
    status: 'queued',
    detail: `${previewSeconds}s`,
    source,
    previewSeconds,
  };
  registerQueuedJob(job);
  drainJobQueue();
  return id;
}

function drainJobQueue(): void {
  syncResourceSlots();
  while (jobQueue.length > 0) {
    const next = jobQueue.find((j) => j.type === 'preview_mp3' && j.status === 'queued');
    if (!next || next.previewSeconds == null) break;
    if (gpuSlots.current >= gpuSlots.max) break;
    const idx = jobQueue.indexOf(next);
    if (idx >= 0) jobQueue.splice(idx, 1);
    next.status = 'running';
    registerQueuedJob(next);
    previewGpuRunning += 1;
    syncResourceSlots();
    const child = spawn(
      process.execPath,
      [resolvedRenderScript, next.videoId, String(next.previewSeconds)],
      {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    previewChildren.add(child);
    let err = '';
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('close', (code) => {
      previewChildren.delete(child);
      previewGpuRunning = Math.max(0, previewGpuRunning - 1);
      next.status = code === 0 ? 'done' : 'failed';
      if (code !== 0)
        next.detail = `${next.previewSeconds}s — ${err.slice(-400) || `exit ${code}`}`;
      registerQueuedJob(next);
      syncResourceSlots();
      pushLog(
        code === 0
          ? `Preview MP3 ok: ${next.videoId} (${next.previewSeconds}s)`
          : `Preview MP3 FAILED: ${next.videoId} (${next.previewSeconds}s) ${err.slice(-200)}`,
      );
      drainJobQueue();
    });
    child.on('error', () => {
      previewChildren.delete(child);
      previewGpuRunning = Math.max(0, previewGpuRunning - 1);
      syncResourceSlots();
    });
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const c of req) {
    byteCount += c.length;
    if (byteCount > MAX_BODY_SIZE) return null;
    chunks.push(c);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

const SYSTEMD_NOTIFY_BIN = '/usr/bin/systemd-notify';

/** sd_notify(3) via systemd-notify (AF_UNIX SOCK_DGRAM; node:dgram has no unix_dgram). */
function sdNotify(state: string, sync = false): boolean {
  if (!process.env.NOTIFY_SOCKET) return true;
  const opts = { env: process.env, timeout: 2000 };
  const logFailure = (err: unknown): false => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[media-pipeline] sd_notify ${state}: ${msg}`);
    return false;
  };
  if (sync) {
    try {
      execFileSync(SYSTEMD_NOTIFY_BIN, [state], opts);
      return true;
    } catch (err) {
      return logFailure(err);
    }
  }
  execFile(SYSTEMD_NOTIFY_BIN, [state], opts, (err) => {
    if (err) logFailure(err);
  });
  return true;
}

function hasStuckRunningJobs(): boolean {
  const thresholdMs = STUCK_JOB_MINUTES * 60 * 1000;
  const now = Date.now();
  for (const job of jobsById.values()) {
    if (job.status !== 'running') continue;
    const active = pipelineActiveJobs.get(job.videoId);
    if (!active?.updatedAt) continue;
    const updated = Date.parse(active.updatedAt);
    if (Number.isFinite(updated) && now - updated > thresholdMs) return true;
  }
  return false;
}

function verifySignature(rawBody, sigHeader, ts) {
  if (!secret) return false;
  if (!sigHeader || typeof sigHeader !== 'string') return false;
  if (!ts || typeof ts !== 'string') return false;
  const m = sigHeader.match(/^sha256=([0-9a-f]{64})$/i);
  if (!m) return false;
  const signedPayload = `${ts}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  const a = Buffer.from(m[1], 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Shared HMAC+timestamp check for signed webhook POSTs; returns error text or null. */
function verifySignedWebhookRequest(req: http.IncomingMessage, rawBody: Buffer): string | null {
  if (!secret) return null;
  const tsHeader = req.headers['x-vmp-timestamp'];
  const ts = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;
  const tsNum = Number(ts);
  if (!ts || !Number.isFinite(tsNum) || tsNum <= 0) return 'Invalid or stale timestamp';
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > 5 * 60) return 'Invalid or stale timestamp';
  const sig = req.headers['x-vmp-signature'];
  if (!verifySignature(rawBody, Array.isArray(sig) ? sig[0] : sig, ts)) {
    return 'Invalid signature';
  }
  return null;
}

function timingSafeEqualString(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyPackagingSecret(req: http.IncomingMessage): boolean {
  if (!packagingSecret) {
    return isLoopbackHost(uiHost);
  }
  const header = req.headers['x-vmp-packaging-secret'];
  const provided = (Array.isArray(header) ? header[0] : header) || '';
  return timingSafeEqualString(provided, packagingSecret);
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
}

function runCommandCapture(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || stdout}`));
      }
    });
  });
}

async function checkAndApplyPodcastHostUpgrade() {
  if (!autoUpgradeEnabled) return;
  let pulled = false;
  try {
    await runCommandCapture('git', ['fetch', 'origin', autoUpgradeBranch], autoUpgradeRepoDir);
    const local = await runCommandCapture('git', ['rev-parse', 'HEAD'], autoUpgradeRepoDir);
    const remote = await runCommandCapture(
      'git',
      ['rev-parse', `origin/${autoUpgradeBranch}`],
      autoUpgradeRepoDir,
    );
    const localSha = local.stdout.trim();
    const remoteSha = remote.stdout.trim();
    if (!localSha || !remoteSha || localSha === remoteSha) return;
    const changed = await runCommandCapture(
      'git',
      ['diff', '--name-only', `${localSha}..${remoteSha}`, '--', autoUpgradePath],
      autoUpgradeRepoDir,
    );
    if (!changed.stdout.trim()) return;
    pushLog(
      `[upgrade] media-pipeline delta detected (${localSha.slice(0, 7)} -> ${remoteSha.slice(0, 7)}), pulling latest changes`,
    );
    await runCommandCapture('git', ['pull', 'origin', autoUpgradeBranch], autoUpgradeRepoDir);
    pulled = true;
    pushLog('[upgrade] pull successful; rebuilding @vmp/media-pipeline');
    await runCommandCapture(
      'npm',
      ['run', 'build', '--workspace=@vmp/media-pipeline'],
      autoUpgradeRepoDir,
    );
    pushLog('[upgrade] build successful; exiting for container/service restart');
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (pulled) {
      pushLog(`[upgrade] build failed after pull; exiting for systemd restart: ${msg}`);
      process.exit(1);
    }
    pushLog(`[upgrade] check failed: ${msg}`);
  }
}

function dashboardHtml() {
  const dashboardAuthRequired = Boolean(dashboardSecret);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>VMP media host</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1.5rem; background: #0f172a; color: #e2e8f0; }
    h1 { font-size: 1.25rem; }
    section { margin: 1rem 0; padding: 1rem; background: #1e293b; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #334155; }
    .ok { color: #4ade80; }
    .fail { color: #f87171; }
    .run { color: #fbbf24; }
    .progress { background: #334155; border-radius: 4px; height: 10px; overflow: hidden; min-width: 120px; }
    .progress > span { display: block; height: 100%; background: linear-gradient(90deg, #22c55e, #4ade80); transition: width 0.4s ease; }
    .progress-meta { font-size: 0.75rem; color: #94a3b8; margin-top: 0.15rem; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 0.75rem; max-height: 16rem; overflow: auto; background: #0f172a; padding: 0.75rem; border-radius: 6px; }
    .btn { font-size: 0.75rem; padding: 0.2rem 0.45rem; margin-right: 0.25rem; cursor: pointer; border-radius: 4px; border: 1px solid #475569; background: #334155; color: #e2e8f0; }
    .btn:hover { background: #475569; }
    .btn-danger { border-color: #b91c1c; background: #7f1d1d; }
    .badge { display: inline-block; font-size: 0.7rem; padding: 0.1rem 0.35rem; border-radius: 4px; background: #334155; color: #cbd5e1; cursor: pointer; }
    .phase-label { font-size: 0.75rem; color: #94a3b8; margin-bottom: 0.15rem; }
  </style>
</head>
<body>
  <h1>VMP media host</h1>
  <p>Local observability for <code>video_pipeline_watch</code> and preview MP3 jobs. Refreshes every 3s.</p>
  <section id="auth-gate" style="display:none">
    <h2>Dashboard access</h2>
    <p>Enter <code>VMP_SUPERVISOR_DASHBOARD_SECRET</code> to view pipeline status and job controls.</p>
    <p><input id="supervisor-token-input" type="password" placeholder="Dashboard secret" style="min-width:18rem;padding:0.35rem 0.5rem" />
    <button class="btn" id="supervisor-token-save" type="button">Unlock</button></p>
    <p id="auth-gate-error" class="fail" style="display:none"></p>
  </section>
  <div id="dashboard-content">
  <section>
    <h2>Pipeline</h2>
    <div id="pipeline">Loading…</div>
  </section>
  <section>
    <h2>Jobs (pipeline)</h2>
    <div id="pipeline-jobs">Loading…</div>
  </section>
  <section>
    <h2>Jobs (preview MP3)</h2>
    <div id="jobs">Loading…</div>
  </section>
  <section>
    <h2>Successful jobs log (pipeline)</h2>
    <div id="pipeline-success">Loading…</div>
  </section>
  <section>
    <h2>Encode workers</h2>
    <div id="workers">Loading…</div>
  </section>
  <section>
    <h2>TTP summaries (time to publish)</h2>
    <div id="ttp">Loading…</div>
  </section>
  <section>
    <h2>Recent log</h2>
    <pre id="log">Loading…</pre>
  </section>
  </div>
  <script>
    const dashboardAuthRequired = ${dashboardAuthRequired ? 'true' : 'false'}
    function supervisorToken() {
      return sessionStorage.getItem('vmp_supervisor_token') || ''
    }
    function supervisorAuthHeaders(extra) {
      const headers = Object.assign({}, extra || {})
      const token = supervisorToken()
      if (token) headers['X-VMP-Supervisor-Token'] = token
      return headers
    }
    function showAuthGate(message) {
      document.getElementById('auth-gate').style.display = 'block'
      document.getElementById('dashboard-content').style.display = 'none'
      const err = document.getElementById('auth-gate-error')
      if (message) {
        err.textContent = message
        err.style.display = 'block'
      } else {
        err.style.display = 'none'
      }
    }
    function showDashboard() {
      document.getElementById('auth-gate').style.display = 'none'
      document.getElementById('dashboard-content').style.display = 'block'
    }
    document.getElementById('supervisor-token-save').addEventListener('click', () => {
      const input = document.getElementById('supervisor-token-input')
      const value = input && 'value' in input ? String(input.value || '').trim() : ''
      if (!value) return
      sessionStorage.setItem('vmp_supervisor_token', value)
      showDashboard()
      tick()
    })
    function startDashboardRefresh() {
      tick()
      setInterval(tick, 3000)
    }
    if (!dashboardAuthRequired) {
      showDashboard()
      startDashboardRefresh()
    } else if (!supervisorToken()) {
      showAuthGate('')
    } else {
      showDashboard()
      startDashboardRefresh()
    }
    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }
    function formatEta(sec) {
      if (sec == null || !Number.isFinite(sec) || sec <= 0) return ''
      const m = Math.floor(sec / 60)
      const s = Math.floor(sec - m * 60)
      return m > 0 ? m + 'm ' + s + 's' : s + 's'
    }
    function dualPhaseProgress(j) {
      const p1 = typeof j.progressPhase1Pct === 'number' ? Math.round(j.progressPhase1Pct * 100) : null
      const p2 = typeof j.progressPhase2Pct === 'number' ? Math.round(j.progressPhase2Pct * 100) : null
      const showP2 = j.progressPhase2Started || (p2 != null && p2 > 0)
      let html = '<div class="phase-label">Phase 1 (720p)</div>'
      html += p1 != null
        ? '<div class="progress" title="Phase 1 ' + p1 + '%"><span style="width:' + p1 + '%"></span></div>'
        : '<div class="progress"><span style="width:0%"></span></div>'
      if (showP2) {
        html += '<div class="phase-label" style="margin-top:0.35rem">Phase 2 (full)</div>'
        html += p2 != null
          ? '<div class="progress" title="Phase 2 ' + p2 + '%"><span style="width:' + p2 + '%"></span></div>'
          : '<div class="progress"><span style="width:0%"></span></div>'
      }
      const meta = []
      if (j.progressRendition) meta.push(j.progressRendition)
      if (typeof j.progressOverall === 'number') meta.push('overall ' + Math.round(j.progressOverall * 100) + '%')
      if (meta.length) html += '<div class="progress-meta">' + escapeHtml(meta.join(' · ')) + '</div>'
      return html
    }
    function jobControls(j) {
      if (!['queued', 'running', 'paused'].includes(j.status)) return ''
      const vid = escapeHtml(j.videoId || '')
      const paused = j.status === 'paused'
      const btns = []
      if (!paused) btns.push('<button class="btn" data-action="pause" data-video="' + vid + '">Pause</button>')
      else btns.push('<button class="btn" data-action="resume" data-video="' + vid + '">Resume</button>')
      btns.push('<button class="btn btn-danger" data-action="stop" data-video="' + vid + '">Stop</button>')
      return btns.join('')
    }
    function priorityBadge(j) {
      const p = j.priority != null ? j.priority : 100
      return '<span class="badge" data-action="priority" data-video="' + escapeHtml(j.videoId || '') + '" title="Click to edit priority">' + p + '</span>'
    }
    async function postJob(path, body) {
      await fetch(path, {
        method: 'POST',
        headers: supervisorAuthHeaders({ 'Content-Type': 'application/json' }),
        body: body ? JSON.stringify(body) : undefined,
      })
    }
    document.addEventListener('click', async (ev) => {
      const el = ev.target
      if (!(el instanceof HTMLElement)) return
      const action = el.getAttribute('data-action')
      const videoId = el.getAttribute('data-video')
      if (!action || !videoId) return
      if (action === 'pause') { await postJob('/api/jobs/' + encodeURIComponent(videoId) + '/pause'); return }
      if (action === 'resume') { await postJob('/api/jobs/' + encodeURIComponent(videoId) + '/resume'); return }
      if (action === 'priority') {
        const next = window.prompt('Priority (lower = sooner)', el.textContent || '100')
        if (next == null) return
        const priority = Number.parseInt(next, 10)
        if (!Number.isFinite(priority)) return
        await postJob('/api/jobs/' + encodeURIComponent(videoId) + '/priority', { priority })
        return
      }
      if (action === 'stop') {
        if (el.getAttribute('data-confirm') !== '1') {
          el.outerHTML = '<span>Confirm stop?</span> <button class="btn btn-danger" data-action="stop" data-confirm="1" data-video="' + escapeHtml(videoId) + '">Yes</button> <button class="btn" data-action="cancel-stop" data-video="' + escapeHtml(videoId) + '">Cancel</button>'
          return
        }
        await postJob('/api/jobs/' + encodeURIComponent(videoId) + '/stop')
        return
      }
      if (action === 'cancel-stop') { tick(); return }
    })
    async function tick() {
      try {
        const r = await fetch('/api/status', { headers: supervisorAuthHeaders() })
        if (r.status === 401) {
          if (dashboardAuthRequired) {
            sessionStorage.removeItem('vmp_supervisor_token')
            showAuthGate('Invalid or missing dashboard secret.')
          }
          return
        }
        const d = await r.json()
        const p = d.pipeline || {}
        document.getElementById('pipeline').innerHTML =
          '<p><strong>Script:</strong> ' + escapeHtml(p.script || '') + '</p>' +
          '<p><strong>PID:</strong> ' + escapeHtml(p.pid ?? '—') +
          ' · <strong>Started:</strong> ' + escapeHtml(p.startedAt || '—') + '</p>' +
          '<p><strong>Status:</strong> ' +
          (p.exited ? ('exited code ' + escapeHtml(p.code) + (p.signal ? ' signal ' + escapeHtml(p.signal) : '')) : 'running') +
          '</p>'
        const pipelineRows = (d.pipelineActiveJobs || []).map(j =>
          '<tr><td>' + dualPhaseProgress(j) + '</td><td>' + escapeHtml(j.status || '') + '</td><td>' + escapeHtml(j.videoId || '') +
          '</td><td>' + escapeHtml(j.stageLabel || j.stage || '') + '</td><td>' + jobControls(j) + '</td><td>' + priorityBadge(j) +
          '</td><td>' + (j.queuePosition != null ? escapeHtml(String(j.queuePosition)) : '—') + '</td><td>' + escapeHtml(j.detail || '') +
          '</td><td>' + escapeHtml(j.source || '') + '</td><td>' + escapeHtml(j.updatedAt || '') + '</td></tr>'
        ).join('')
        document.getElementById('pipeline-jobs').innerHTML = '<table><thead><tr><th>Progress</th><th>Status</th><th>Video</th><th>Stage</th><th>Controls</th><th>Priority</th><th>Queue #</th><th>Detail</th><th>Source</th><th>Updated</th></tr></thead><tbody>' + pipelineRows + '</tbody></table>'
        const queued = (d.jobQueue || []).filter(j => j.status === 'queued')
        const rows = queued.map(j =>
          '<tr><td>' + escapeHtml(j.status || '') + '</td><td>' + escapeHtml(j.type || '') + '</td><td>' + escapeHtml(j.videoId || '') +
          '</td><td>' + escapeHtml(j.detail || '') + '</td><td>' + priorityBadge(j) + '</td><td>' + (j.queuePosition != null ? escapeHtml(String(j.queuePosition)) : '—') +
          '</td><td>' + escapeHtml(j.source || '') + '</td></tr>'
        ).join('')
        document.getElementById('jobs').innerHTML = '<table><thead><tr><th>Status</th><th>Type</th><th>Video</th><th>Detail</th><th>Priority</th><th>Queue #</th><th>Source</th></tr></thead><tbody>' + rows + '</tbody></table>'
        const successRows = (d.pipelineSuccessfulJobs || []).map(j =>
          '<tr><td>' + escapeHtml(j.videoId || '') + '</td><td>' + escapeHtml(j.stageLabel || j.stage || '') + '</td><td>' + escapeHtml(j.detail || '') + '</td><td>' + escapeHtml(j.finishedAt || '') + '</td></tr>'
        ).join('')
        document.getElementById('pipeline-success').innerHTML = '<table><thead><tr><th>Video</th><th>Final stage</th><th>Detail</th><th>Finished</th></tr></thead><tbody>' + successRows + '</tbody></table>'
        const ttpRows = (d.ttpSummaries || []).map(s =>
          '<tr><td>' + escapeHtml(s.videoId || '') + '</td><td>' + escapeHtml(s.minimalMs != null ? (s.minimalMs / 1000).toFixed(1) + 's' : '—') + '</td><td>' + escapeHtml(s.fullMs != null ? (s.fullMs / 1000).toFixed(1) + 's' : '—') + '</td><td>' + escapeHtml(s.minimalRatio != null ? Number(s.minimalRatio).toFixed(2) + '×' : '—') + '</td><td>' + escapeHtml(s.fullRatio != null ? Number(s.fullRatio).toFixed(2) + '×' : '—') + '</td><td>' + escapeHtml(s.at || '') + '</td></tr>'
        ).join('')
        document.getElementById('ttp').innerHTML = '<table><thead><tr><th>Video</th><th>Minimal (720p)</th><th>Full renditions</th><th>Ratio minimal</th><th>Ratio full</th><th>At</th></tr></thead><tbody>' + ttpRows + '</tbody></table>'
        const workerRows = (d.workers || []).map(w =>
          '<tr><td>' + escapeHtml(w.hostname || w.workerId || '') + '</td><td>' + escapeHtml(w.gpuBackend || '') +
          '</td><td>' + escapeHtml(String(w.pollQueue ?? '')) + '</td><td>' + escapeHtml(w.version || '—') +
          '</td><td>' + escapeHtml(w.lastSeenAt || '') + '</td></tr>'
        ).join('')
        document.getElementById('workers').innerHTML = workerRows
          ? '<table><thead><tr><th>Worker</th><th>Backend</th><th>Poll queue</th><th>Version</th><th>Last heartbeat</th></tr></thead><tbody>' + workerRows + '</tbody></table>'
          : '<p>No live workers — jobs will queue until a worker compose registers.</p>'
        document.getElementById('log').textContent = (d.logLines || []).join('\\n')
      } catch (e) {
        document.getElementById('pipeline').textContent = 'Error: ' + e
      }
    }
  </script>
</body>
</html>`;
}

function rejectUnauthorizedDashboard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): boolean {
  if (!requiresDashboardAuth(pathname, method)) return false;
  if (verifyDashboardSecret(req, dashboardSecret)) return false;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized', code: 'dashboard_auth_required' }));
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${uiHost}:${uiPort}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (rejectUnauthorizedDashboard(req, res, pathname, method)) return;

  if (method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const activeRows = Array.from(pipelineActiveJobs.values())
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((job) => ({
        ...job,
        stageLabel: stageLabel(job.stage),
        queuePosition: getQueuePosition(job.videoId),
      }));
    const successRows = pipelineSuccessfulJobs.map((job) => ({
      ...job,
      stageLabel: stageLabel(job.stage),
    }));
    const failedRows = failedPipelineJobs.map((job) => ({
      ...job,
      stageLabel: stageLabel(job.stage),
    }));
    sortJobQueue();
    const queuedJobs = jobQueue
      .filter((j) => j.status === 'queued')
      .map((j) => ({ ...j, queuePosition: getQueuePosition(j.videoId) }));
    json(res, {
      pipeline: {
        script: resolvedPipelineScript,
        renderScript: resolvedRenderScript,
        runPipeline,
        pid: pipelineState.pid,
        startedAt: pipelineState.startedAt,
        exited: pipelineState.exited,
        code: pipelineState.code,
        signal: pipelineState.signal,
        ipcPath: pipelineIpcPath,
      },
      gpuSlots,
      uploadSlots,
      previewGpuRunning,
      jobQueue: queuedJobs,
      jobs: Array.from(jobsById.values()),
      pipelineActiveJobs: activeRows,
      pipelineSuccessfulJobs: successRows,
      failedPipelineJobs: failedRows,
      workers: await listWorkers(),
      ttpSummaries,
      logLines,
    });
    return;
  }

  if (REBUILD_WEBHOOK_PATHS.has(url.pathname) && req.method !== 'POST') {
    json(
      res,
      {
        error: 'Method not allowed',
        expectedMethod: 'POST',
        endpoint: '/api/podcast-preview-rebuild',
      },
      405,
    );
    return;
  }

  if (req.method === 'POST' && REBUILD_WEBHOOK_PATHS.has(url.pathname)) {
    const chunks = [];
    let byteCount = 0;
    for await (const c of req) {
      byteCount += c.length;
      if (byteCount > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    }
    const rawBody = Buffer.concat(chunks);

    const webhookAuthError = verifySignedWebhookRequest(req, rawBody);
    if (webhookAuthError) {
      json(res, { error: webhookAuthError }, 401);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      json(res, { error: 'Invalid JSON' }, 400);
      return;
    }

    if (payload?.event !== 'podcast_preview_rebuild') {
      json(
        res,
        {
          error: 'Unexpected event',
          code: 'invalid_event',
          expectedEvent: 'podcast_preview_rebuild',
        },
        400,
      );
      return;
    }

    const videos = Array.isArray(payload.videos) ? payload.videos : [];
    const accepted = [];
    const rejected = [];
    for (const v of videos) {
      const id = v?.id;
      const sec = Number(v?.previewDurationSeconds);
      const fullSec = Number(v?.fullDurationSeconds);
      if (!id || !Number.isFinite(sec) || sec <= 0) {
        rejected.push({ id: String(id || ''), reason: 'invalid_preview_duration' });
        continue;
      }
      if (Number.isFinite(fullSec) && fullSec > 0 && sec >= fullSec - 0.5) {
        rejected.push({ id: String(id), reason: 'full_unlock' });
        continue;
      }
      // Reject path-like IDs to prevent directory traversal
      if (typeof id !== 'string' || id.includes('/') || id.includes('\\') || id.includes('..')) {
        pushLog(`Rejected invalid video ID: ${id}`);
        rejected.push({ id: String(id || ''), reason: 'invalid_video_id' });
        continue;
      }
      // Stricter validation: allow only alphanumerics, dash, dot, underscore
      if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
        pushLog(`Rejected invalid video ID: ${id}`);
        rejected.push({ id: String(id || ''), reason: 'invalid_video_id' });
        continue;
      }
      accepted.push({
        jobId: enqueuePreview(id, Math.floor(sec), 'webhook'),
        videoId: id,
        previewSeconds: Math.floor(sec),
      });
    }

    json(
      res,
      {
        ok: true,
        code: 'accepted',
        acceptedCount: accepted.length,
        rejectedCount: rejected.length,
        jobs: accepted,
        rejected,
      },
      accepted.length > 0 ? 202 : 200,
    );
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, { ok: true });
    return;
  }

  const jobControlMatch = url.pathname.match(
    /^\/api\/jobs\/([^/]+)\/(pause|resume|stop|priority)$/,
  );
  if (req.method === 'POST' && jobControlMatch) {
    let videoId: string;
    try {
      videoId = decodeURIComponent(jobControlMatch[1]);
    } catch {
      json(res, { error: 'Invalid job id' }, 400);
      return;
    }
    const action = jobControlMatch[2];
    if (action === 'priority') {
      const body = await readJsonBody(req);
      if (body === null) {
        json(res, { error: 'Invalid JSON' }, 400);
        return;
      }
      const priority = Number((body as { priority?: number }).priority);
      if (!Number.isFinite(priority)) {
        json(res, { error: 'Invalid priority' }, 400);
        return;
      }
      const job = getQueuedJob('pipeline', videoId);
      if (job) {
        job.priority = priority;
        registerQueuedJob(job);
      }
      const active = pipelineActiveJobs.get(videoId);
      if (active) active.priority = priority;
      sortJobQueue();
      json(res, { ok: true, newPosition: getQueuePosition(videoId) });
      return;
    }
    const ipcResult = await sendPipelineCommand(action as 'pause' | 'resume' | 'stop', videoId);
    if (!ipcResult.ok) {
      json(res, ipcResult, 502);
      return;
    }
    const job = getQueuedJob('pipeline', videoId);
    if (job) {
      if (action === 'pause') job.status = 'paused';
      else if (action === 'resume') job.status = 'running';
      else if (action === 'stop') job.status = 'stopped';
      registerQueuedJob(job);
    }
    const active = pipelineActiveJobs.get(videoId);
    if (active) {
      if (action === 'pause') active.status = 'paused';
      else if (action === 'resume') active.status = 'active';
      else if (action === 'stop') {
        active.status = 'failed';
        active.detail = 'stopped_by_user';
      }
    }
    json(res, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/jobs/reorder') {
    const body = await readJsonBody(req);
    if (body === null) {
      json(res, { error: 'Invalid JSON' }, 400);
      return;
    }
    const order = (body as { order?: string[] }).order;
    if (!Array.isArray(order)) {
      json(res, { error: 'Missing order array' }, 400);
      return;
    }
    const ipcResult = await sendPipelineCommand('reorder', undefined, { order: order.map(String) });
    if (!ipcResult.ok) {
      json(res, ipcResult, 502);
      return;
    }
    order.forEach((videoId, index) => {
      const job = getQueuedJob('pipeline', String(videoId));
      if (job) {
        job.priority = index;
        registerQueuedJob(job);
      }
      const active = pipelineActiveJobs.get(String(videoId));
      if (active) active.priority = index;
    });
    sortJobQueue();
    json(res, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/packaging/enqueue') {
    if (!verifyPackagingSecret(req)) {
      json(res, { error: 'Unauthorized' }, 401);
      return;
    }
    const body = await readJsonBody(req);
    if (body === null) {
      json(res, { error: 'Invalid JSON' }, 400);
      return;
    }
    const reg = body as {
      jobId?: string;
      encoreJobUrl?: string;
      videoId?: string;
      stage?: string;
      pipelineMode?: string;
      aggregate?: { inputUri?: string; memberJobIds?: string[] };
    };
    if (!reg.jobId || !reg.encoreJobUrl || !reg.videoId || !reg.stage || !reg.pipelineMode) {
      json(res, { error: 'Missing required fields' }, 400);
      return;
    }
    if (
      reg.aggregate &&
      (!reg.aggregate.inputUri ||
        !Array.isArray(reg.aggregate.memberJobIds) ||
        reg.aggregate.memberJobIds.length === 0)
    ) {
      json(res, { error: 'aggregate requires inputUri and memberJobIds' }, 400);
      return;
    }
    const validStages: string[] = ['fast_lane_preview', 'full_ladder'];
    const validPipelineModes: string[] = ['fast_lane', 'full_ladder'];
    if (!validStages.includes(reg.stage)) {
      json(res, { error: `Invalid stage: ${reg.stage}` }, 400);
      return;
    }
    if (!validPipelineModes.includes(reg.pipelineMode)) {
      json(res, { error: `Invalid pipelineMode: ${reg.pipelineMode}` }, 400);
      return;
    }
    let packagerJobUrl: string;
    try {
      packagerJobUrl = rewriteEncoreJobUrlForPackager(String(reg.encoreJobUrl));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[supervisor] Invalid packager Encore URL rewrite:', msg);
      json(res, { error: 'Invalid packager Encore URL' }, 500);
      return;
    }
    if (packagerJobUrl !== reg.encoreJobUrl) {
      pushLog(`packaging rewrite encoreJobUrl ${reg.encoreJobUrl} → ${packagerJobUrl}`);
    }
    // Aggregate URLs are fetched by the packager, which sends no headers —
    // embed a one-shot per-job token rather than the master secret so the
    // credential persisted in Redis (registry + queue message) is scoped to
    // this job only.
    let aggregateToken: string | undefined;
    if (reg.aggregate) {
      aggregateToken = crypto.randomUUID();
      const parsed = new URL(packagerJobUrl);
      parsed.username = 'vmp';
      parsed.password = aggregateToken;
      packagerJobUrl = parsed.toString();
    }
    await registerPackagingJob({
      jobId: String(reg.jobId),
      encoreJobUrl: packagerJobUrl,
      videoId: String(reg.videoId),
      stage: reg.stage as 'fast_lane_preview' | 'full_ladder',
      pipelineMode: reg.pipelineMode as 'fast_lane' | 'full_ladder',
      aggregate: reg.aggregate
        ? {
            inputUri: String(reg.aggregate.inputUri || ''),
            memberJobIds: Array.isArray(reg.aggregate.memberJobIds)
              ? reg.aggregate.memberJobIds.map(String)
              : [],
          }
        : undefined,
      aggregateToken,
    });
    try {
      await enqueuePackagerJob(String(reg.jobId), packagerJobUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markPackagingFailed(String(reg.jobId), msg);
      console.error('[supervisor] Failed to enqueue packaging job:', msg);
      json(res, { error: 'Failed to enqueue packaging job' }, 502);
      return;
    }
    json(res, { ok: true, jobId: reg.jobId }, 202);
    return;
  }

  const packagingStatusMatch = url.pathname.match(/^\/api\/packaging\/status\/([^/]+)$/);
  if (req.method === 'GET' && packagingStatusMatch) {
    if (!verifyPackagingSecret(req)) {
      json(res, { error: 'Unauthorized' }, 401);
      return;
    }
    let jobId: string;
    try {
      jobId = decodeURIComponent(packagingStatusMatch[1]);
    } catch {
      json(res, { error: 'Invalid job id' }, 400);
      return;
    }
    const job = await getPackagingJob(jobId);
    if (!job) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    json(res, {
      status: job.status,
      outputPath: job.outputPath,
      error: job.error,
      stage: job.stage,
      pipelineMode: job.pipelineMode,
      videoId: job.videoId,
    });
    return;
  }

  const packagerCallbackMatch = url.pathname.match(
    /^\/vmp\/api\/packagerCallback\/(success|failure)$/,
  );
  if (req.method === 'POST' && packagerCallbackMatch) {
    // Eyevinn encore-packager authenticates via Basic auth in CALLBACK_URL (not a custom header).
    if (!verifyPackagerCallbackSecret(req, packagerSecret || '')) {
      json(res, { error: 'Unauthorized' }, 401);
      return;
    }

    const outcome = packagerCallbackMatch[1];
    const body = await readJsonBody(req);
    if (body === null) {
      json(res, { error: 'Invalid JSON' }, 400);
      return;
    }
    const payload = body as {
      jobId?: string;
      outputPath?: string;
      error?: string;
      message?: string;
    };
    const jobId = resolvePackagerCallbackJobId(payload);
    if (!jobId) {
      json(res, { error: 'Missing jobId' }, 400);
      return;
    }
    if (outcome === 'success') {
      await markPackagingSuccess(
        jobId,
        payload.outputPath ? String(payload.outputPath) : undefined,
      );
      pushLog(`packager success jobId=${jobId}`);
    } else {
      const errMsg = String(payload.error || payload.message || 'packager failure');
      await markPackagingFailed(jobId, errMsg);
      pushLog(`packager failure jobId=${jobId}: ${errMsg}`);
    }
    json(res, { ok: true });
    return;
  }

  // ── Encode worker fleet ────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/workers/heartbeat') {
    if (!workerToken || !verifyWorkerToken(req)) {
      json(res, { error: 'Unauthorized' }, 401);
      return;
    }
    const body = (await readJsonBody(req)) as {
      workerId?: string;
      hostname?: string;
      gpuBackend?: string;
      pollQueue?: number;
      pollHigherPrio?: boolean;
      version?: string;
    } | null;
    const workerId = String(body?.workerId || '').trim();
    const gpuBackend = String(body?.gpuBackend || '').trim() as WorkerGpuBackend;
    const pollQueue = Number(body?.pollQueue);
    if (
      !/^[a-zA-Z0-9._:-]{1,128}$/.test(workerId) ||
      !WORKER_BACKENDS.has(gpuBackend) ||
      !Number.isInteger(pollQueue) ||
      pollQueue < 0 ||
      pollQueue > 16 ||
      // Reject rather than coerce a malformed capability — a truthy string
      // would silently register a worker as higher-prio-capable.
      (body?.pollHigherPrio !== undefined && typeof body.pollHigherPrio !== 'boolean')
    ) {
      json(res, { error: 'Invalid worker heartbeat' }, 400);
      return;
    }
    const record = await recordWorkerHeartbeat({
      workerId,
      hostname: String(body?.hostname || workerId).slice(0, 128),
      gpuBackend,
      pollQueue,
      pollHigherPrio:
        typeof body?.pollHigherPrio === 'boolean' ? body.pollHigherPrio : undefined,
      version: body?.version ? String(body.version).slice(0, 64) : undefined,
    });
    json(res, { ok: true, worker: record });
    return;
  }

  // ── Packager-facing aggregate job doc (rendition-split ladders) ────────
  const aggregateMatch = url.pathname.match(/^\/vmp\/api\/encoreJobAggregate\/([^/]+)$/);
  if (req.method === 'GET' && aggregateMatch) {
    let aggregateJobId: string;
    try {
      aggregateJobId = decodeURIComponent(aggregateMatch[1]);
    } catch {
      json(res, { error: 'Invalid job id' }, 400);
      return;
    }
    const record = await getPackagingJob(aggregateJobId);
    if (!record?.aggregate) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    // The packager authenticates with the per-job token embedded in its copy
    // of encoreJobUrl. Records queued before that rollout have no token and
    // carry the shared secret instead — keep accepting it until they drain.
    const password = extractBasicAuthPassword(req);
    const authorized = record.aggregateToken
      ? password !== null && timingSafeEqualString(password, record.aggregateToken)
      : verifyPackagerCallbackSecret(req, packagerSecret || '');
    if (!authorized) {
      json(res, { error: 'Unauthorized' }, 401);
      return;
    }
    try {
      const members = await Promise.all(record.aggregate.memberJobIds.map(getEncoreJob));
      const doc = buildAggregateEncoreJobDoc(
        {
          jobId: record.jobId,
          videoId: record.videoId,
          inputUri: record.aggregate.inputUri,
          memberJobIds: record.aggregate.memberJobIds,
        },
        members,
      );
      json(res, doc);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 502);
    }
    return;
  }

  // ── tusd post-finish hook → move completed upload into the inbox ───────
  if (req.method === 'POST' && url.pathname === '/vmp/api/tus-hook') {
    if (!verifyPackagerCallbackSecret(req, packagerSecret || '')) {
      json(res, { error: 'Unauthorized' }, 401);
      return;
    }
    const body = await readJsonBody(req);
    try {
      const uploadId = String(
        (body as { Event?: { Upload?: { ID?: string } } })?.Event?.Upload?.ID ??
          (body as { event?: { upload?: { id?: string } } })?.event?.upload?.id ??
          '',
      );
      // Durable replay dedupe — after a successful publish the filestore
      // source is gone, so a replayed hook must be answered from the tombstone
      // before planTusIntake can touch the (now-missing) file.
      if (uploadId) {
        const published = await tusPublishedDestination(uploadId);
        if (published) {
          json(res, { ok: true, file: published, replayed: true });
          return;
        }
      }
      const plan = planTusIntake(body as Parameters<typeof planTusIntake>[0]);
      if (!plan) {
        json(res, { ok: true, ignored: true });
        return;
      }
      const outcome = await publishToInbox(plan.srcPath, plan.destPath, plan.pipelineMode);
      if (outcome === 'conflict') {
        // A different upload already owns this destination — the source file
        // stays in TUSD_DATA_DIR for operator reconciliation instead of being
        // silently accepted as the wrong video.
        json(res, { error: 'Destination already exists for a different upload', code: 'conflict' }, 409);
        return;
      }
      if (uploadId) await recordTusPublished(uploadId, plan.destBasename);
      increment('vmp.tus.upload.accepted', 1, { mode: plan.pipelineMode });
      pushLog(`tus upload → ${plan.pipelineMode} inbox: ${plan.destBasename}`);
      json(res, { ok: true, file: plan.destBasename, pipelineMode: plan.pipelineMode });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return;
  }

  // ── API-driven ingest: pull a raw upload through the video proxy → inbox ──
  if (req.method === 'POST' && url.pathname === '/vmp/api/ingest') {
    // This route is exempt from dashboard auth; it must fail closed on HMAC
    // even when VMP_REQUIRE_WEBHOOK_SECRET=0.
    if (!secret) {
      json(res, { error: 'Webhook secret not configured' }, 503);
      return;
    }
    const chunks: Buffer[] = [];
    let byteCount = 0;
    try {
      for await (const c of req) {
        byteCount += c.length;
        if (byteCount > MAX_BODY_SIZE) {
          json(res, { error: 'Request body too large' }, 413);
          req.destroy();
          return;
        }
        chunks.push(c);
      }
    } catch {
      if (!res.writableEnded && !res.destroyed) {
        json(res, { error: 'Request body read failed' }, 400);
      }
      return;
    }
    const rawBody = Buffer.concat(chunks);
    const authError = verifySignedWebhookRequest(req, rawBody);
    if (authError) {
      json(res, { error: authError }, 401);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      json(res, { error: 'Invalid JSON' }, 400);
      return;
    }
    let plan;
    try {
      plan = planIngest(payload as Parameters<typeof planIngest>[0], apiBaseUrl);
    } catch (err) {
      json(
        res,
        {
          error: err instanceof Error ? err.message : String(err),
          code: err instanceof IngestPlanError ? err.code : 'invalid_request',
        },
        400,
      );
      return;
    }
    // Acknowledge the durable intake request immediately — the download can
    // take minutes for large sources, so /complete must not wait for it.
    // Deduped by destination: a concurrent retry of the same upload is a no-op.
    const dedupeKey = plan.destPath;
    if (!ingestInFlight.has(dedupeKey)) {
      ingestInFlight.add(dedupeKey);
      void runSourceIngest(plan)
        .catch((err) =>
          pushLog(
            `ingest failed for ${plan.destBasename}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        .finally(() => ingestInFlight.delete(dedupeKey));
    }
    json(res, { ok: true, accepted: true, file: plan.destBasename, pipelineMode: plan.pipelineMode }, 202);
    return;
  }

  // ── Authenticated TUS upload endpoint (proxied to tusd) ────────────────
  if (url.pathname === '/vmp/uploads' || url.pathname.startsWith('/vmp/uploads/')) {
    await proxyTusRequest(req, res, url.pathname);
    return;
  }

  // ── Prometheus metrics ─────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/metrics') {
    const text = await buildMetricsText();
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(text);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

function verifyWorkerToken(req: http.IncomingMessage): boolean {
  const header = req.headers['x-vmp-worker-token'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (typeof provided === 'string' && provided.length > 0) {
    return timingSafeEqualString(provided, workerToken);
  }
  return verifyPackagerCallbackSecret(req, workerToken);
}

/** Proxy /vmp/uploads[/<id>] → tusd /files[/<id>]; dashboard auth already applied. */
async function proxyTusRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<void> {
  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'POST, HEAD, PATCH, OPTIONS, DELETE',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Upload-Length, Upload-Offset, Upload-Metadata, Tus-Resumable',
    'Access-Control-Expose-Headers': 'Location, Upload-Offset, Upload-Length, Tus-Resumable',
    'Tus-Resumable': '1.0.0',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...corsHeaders, 'Tus-Version': '1.0.0', 'Tus-Extension': 'creation' });
    res.end();
    return;
  }
  const suffix = pathname === '/vmp/uploads' ? '' : pathname.slice('/vmp/uploads'.length);
  const upstream = new URL(`${TUSD_URL}/files${suffix}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (
      ['host', 'authorization', 'x-vmp-supervisor-token', 'connection', 'content-length'].includes(
        key,
      )
    ) {
      continue;
    }
    if (typeof v === 'string') headers[k] = v;
  }
  const proxyReq = http.request(
    upstream,
    { method: req.method, headers, timeout: 0 },
    (proxyRes) => {
      const outHeaders: Record<string, string | string[]> = { ...corsHeaders };
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (v == null) continue;
        const key = k.toLowerCase();
        if (key === 'location') {
          // tusd returns http://tusd:1080/files/<id> — rewrite to our public path.
          outHeaders[k] = String(v).replace(
            /^https?:\/\/[^/]+\/files/,
            `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/vmp/uploads`,
          );
          continue;
        }
        if (key === 'connection' || key === 'transfer-encoding') continue;
        outHeaders[k] = v as string | string[];
      }
      res.writeHead(proxyRes.statusCode || 502, outHeaders);
      // If tusd drops mid-body, pipe() alone leaves the error unhandled and
      // crashes the supervisor — only the downstream response should die.
      proxyRes.on('error', () => res.destroy());
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('timeout', () => proxyReq.destroy(new Error('tusd upstream timeout')));
  proxyReq.on('error', (err) => {
    if (!res.headersSent) json(res, { error: `tusd unreachable: ${err.message}` }, 502);
    else res.destroy();
  });
  req.pipe(proxyReq);
}

async function buildMetricsText(): Promise<string> {
  const lines: string[] = [];
  const g = (name: string, value: number, labels = '') => {
    lines.push(`vmp_${name}${labels ? `{${labels}}` : ''} ${Number.isFinite(value) ? value : 0}`);
  };
  const esc = (s: string) => s.replace(/["\\]/g, '\\$&');

  g('pipeline_child_alive', pipelineChild && !pipelineState.exited ? 1 : 0);
  g('pipeline_queue_depth', jobQueue.filter((j) => j.status === 'queued').length);
  g('supervisor_gpu_slots_used', gpuSlots.current);
  g('supervisor_gpu_slots_max', gpuSlots.max);
  g('supervisor_upload_slots_used', uploadSlots.current);
  g('supervisor_upload_slots_max', uploadSlots.max);

  const stageCounts = new Map<string, number>();
  for (const job of pipelineActiveJobs.values()) {
    const stage = String(job.stage || 'unknown');
    stageCounts.set(stage, (stageCounts.get(stage) || 0) + 1);
  }
  // Emit every known stage (zero included) so graphs don't go stale when the
  // last job leaves a stage.
  for (const stage of Object.keys(STAGE_LABELS)) {
    g('pipeline_active_jobs', stageCounts.get(stage) ?? 0, `stage="${esc(stage)}"`);
  }
  for (const [stage, count] of stageCounts) {
    if (!(stage in STAGE_LABELS)) g('pipeline_active_jobs', count, `stage="${esc(stage)}"`);
  }
  g('pipeline_jobs_failed_total', failedPipelineJobs.length);
  g('pipeline_jobs_success_total', pipelineSuccessfulJobs.length);

  const workers = await listWorkers();
  const byBackend = new Map<string, number>();
  for (const w of workers) byBackend.set(w.gpuBackend, (byBackend.get(w.gpuBackend) || 0) + 1);
  for (const backend of ['cpu', 'nvenc', 'vaapi']) {
    g('workers', byBackend.get(backend) ?? 0, `backend="${esc(backend)}"`);
    byBackend.delete(backend);
  }
  for (const [backend, count] of byBackend) g('workers', count, `backend="${esc(backend)}"`);
  g('workers_total', workers.length);

  const packagerStatusCounts = new Map<string, number>();
  for (const job of listPackagingJobs()) {
    const status = String(job.status || 'unknown');
    packagerStatusCounts.set(status, (packagerStatusCounts.get(status) || 0) + 1);
  }
  for (const [status, count] of packagerStatusCounts) {
    g('packaging_jobs', count, `status="${esc(status)}"`);
  }

  g('redis_up', (await redisHealthy()) ? 1 : 0);

  let encoreUp = 0;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const r = await fetch(`${ENCORE_BASE}/queueCount`, { signal: controller.signal });
      if (r.ok) {
        const data = (await r.json()) as unknown;
        const counts = Array.isArray(data)
          ? data
          : data && typeof data === 'object'
            ? Object.values(data as Record<string, unknown>)
            : [];
        // Mark Encore up only once a parseable, non-empty queue map arrived.
        if (counts.length > 0) {
          encoreUp = 1;
          counts.forEach((v, i) => {
            if (typeof v === 'number') g('encore_queue_depth', v, `queue="${i}"`);
          });
        }
      }
    } finally {
      // Timer covers body consumption too — a dead Encore mid-JSON still
      // reports worker/pipeline/redis metrics via the outer catch.
      clearTimeout(timer);
    }
  } catch {
    /* encore down */
  }
  g('encore_up', encoreUp);

  const lastTtp = ttpSummaries[0];
  if (lastTtp) {
    if (lastTtp.minimalMs != null) g('ttp_last_minimal_ms', lastTtp.minimalMs);
    if (lastTtp.fullMs != null) g('ttp_last_full_ms', lastTtp.fullMs);
    g('ttp_last_total_ms', lastTtp.totalMs);
  }
  g('process_uptime_seconds', Math.floor(process.uptime()));
  g('process_rss_bytes', process.memoryUsage().rss);
  return `${lines.join('\n')}\n`;
}

/**
 * Replays completed tusd uploads whose post-finish hook exhausted retries
 * while the supervisor was down — the file + .info sidecar sit in
 * TUSD_DATA_DIR until something moves them into the inbox.
 */
async function recoverOrphanedTusUploads(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(tusdDataDir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.info')) continue;
    try {
      const info = JSON.parse(await fs.promises.readFile(path.join(tusdDataDir(), entry), 'utf8')) as {
        ID?: string;
        IsFinal?: boolean;
        IsPartial?: boolean;
        Offset?: number;
        Size?: number;
        SizeIsDeferred?: boolean;
        MetaData?: Record<string, string>;
        Storage?: { Type?: string; Path?: string };
      };
      // A leftover .info from an already-published upload — the source file
      // was moved out; the tombstone is the record of delivery.
      if (info.ID && (await tusPublishedDestination(info.ID))) continue;
      // Completion proof = the stored file matching a declared, non-deferred
      // length. Offset in the sidecar can lag (filestore keeps it in memory),
      // IsFinal alone doesn't prove concatenation finished, and a deferred
      // upload with Size=0 must never be moved out from under a live resume.
      const st = info.Storage?.Path
        ? await fs.promises.stat(info.Storage.Path).catch(() => null)
        : null;
      const complete =
        st !== null &&
        info.SizeIsDeferred !== true &&
        typeof info.Size === 'number' &&
        info.Size > 0 &&
        st.size === info.Size;
      // Already-consumed uploads leave a stale .info behind — skip quietly.
      if (!complete || !st) continue;
      const uploadId = info.ID ?? entry.replace(/\.info$/, '');
      const plan = planTusIntake({
        Type: 'post-finish',
        Event: {
          Upload: {
            ID: uploadId,
            IsPartial: info.IsPartial,
            MetaData: info.MetaData,
            Storage: info.Storage,
          },
        },
      });
      if (!plan) continue;
      const outcome = await publishToInbox(plan.srcPath, plan.destPath, plan.pipelineMode);
      if (outcome === 'conflict') {
        pushLog(`tus recovery: ${entry} conflicts with an existing inbox file — needs operator review`);
        continue;
      }
      await recordTusPublished(uploadId, plan.destBasename);
      pushLog(`tus recovery: republished orphaned upload ${entry}`);
    } catch (err) {
      pushLog(
        `tus recovery: skipped ${entry}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function bootSupervisor(): Promise<void> {
  if (process.env.VMP_SKIP_PIPELINE_DOCTOR !== '1') {
    pushLog('Running pipeline doctor…');
    const report = await runPipelineDoctor(process.env);
    process.stdout.write(`${formatDoctorReport(report)}\n`);
    if (!report.ok) {
      console.error(
        '[media-pipeline] Pipeline doctor failed — fix env/deps or set VMP_SKIP_PIPELINE_DOCTOR=1',
      );
      process.exit(1);
    }
  } else {
    pushLog('Pipeline doctor skipped (VMP_SKIP_PIPELINE_DOCTOR=1)');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(uiPort, uiHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  pushLog(
    `Dashboard http://${uiHost}:${uiPort}/  (webhook POST /api/podcast-preview-rebuild or /vmp/api/podcast-preview-rebuild)`,
  );
  pushLog(
    `Config: runPipeline=${runPipeline} gpuConcurrency=${MAX_GPU_JOBS} uploadConcurrency=${MAX_UPLOAD_JOBS} pipelineScript=${resolvedPipelineScript} renderScript=${resolvedRenderScript}`,
  );
  if (!sdNotify('READY=1', true)) {
    console.error('[media-pipeline] failed to notify systemd READY=1; exiting');
    process.exit(1);
  }
  startPipeline();
  void recoverOrphanedTusUploads();
  setInterval(() => {
    reportSupervisorMetrics();
    drainPendingIntakeHandoffs();
    if (pipelineChild && !pipelineState.exited && !hasStuckRunningJobs()) {
      void sdNotify('WATCHDOG=1');
    }
  }, 20_000);
  if (autoUpgradeEnabled) {
    pushLog(
      `[upgrade] enabled, watching ${autoUpgradePath} on ${autoUpgradeBranch} every ${Math.round(autoUpgradeCheckMs / 1000)}s`,
    );
    void checkAndApplyPodcastHostUpgrade();
    setInterval(() => {
      void checkAndApplyPodcastHostUpgrade();
    }, autoUpgradeCheckMs);
  }
}

void bootSupervisor().catch((err) => {
  console.error('[media-pipeline] boot failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

const gracefulShutdown = async (signal) => {
  pushLog(`${signal} — stopping`);
  sdNotify('STOPPING=1', true);
  if (pipelineRestartTimer) clearTimeout(pipelineRestartTimer);
  if (pipelineChild && !pipelineState.exited) {
    try {
      pipelineChild.kill('SIGTERM');
    } catch {}
  }
  for (const child of previewChildren) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  // Give children a moment to exit gracefully
  await new Promise((resolve) => setTimeout(resolve, 1000));
  for (const child of previewChildren) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  server.close(() => process.exit(0));
};

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});
