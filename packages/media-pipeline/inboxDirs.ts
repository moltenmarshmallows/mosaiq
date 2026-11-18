import path from 'node:path';
import type { PipelineMode } from './pipelineMode.js';

/**
 * Dual-ingest watchfolders shared by pipeline_watch and the supervisor's
 * TUS post-finish hook (which drops completed uploads into these same dirs).
 */
export function resolveInboxDir(mode: PipelineMode, env: NodeJS.ProcessEnv = process.env): string {
  const legacy = (env.INBOX_DIR || '').trim();
  const fastLane =
    (env.INBOX_FAST_LANE_DIR || '').trim() ||
    (legacy ? path.join(legacy, 'fast-lane') : '/mnt/videos/inbox-fast-lane');
  const fullLadder =
    (env.INBOX_FULL_LADDER_DIR || '').trim() ||
    (legacy ? path.join(legacy, 'full-ladder') : '/mnt/videos/inbox-full-ladder');
  return mode === 'full_ladder' ? fullLadder : fastLane;
}
