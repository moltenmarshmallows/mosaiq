/**
 * TUS upload intake — maps a tusd post-finish hook payload to a move into the
 * pipeline watchfolders. The watchfolder then assigns the video ID exactly as
 * it does for NAS-dropped files (or honors meta_data.videoId verbatim).
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveInboxDir } from './inboxDirs.js';
import type { PipelineMode } from './pipelineMode.js';

export type TusHookPayload = {
  type?: string;
  event?: {
    upload?: {
      id?: string;
      size?: number;
      meta_data?: Record<string, string>;
      metadata?: Record<string, string>;
      storage?: { type?: string; path?: string };
    };
  };
};

export type TusIntakePlan = {
  srcPath: string;
  destPath: string;
  destBasename: string;
  pipelineMode: PipelineMode;
  videoIdHint?: string;
};

const SAFE_ID = /^[a-zA-Z0-9._-]{1,200}$/;
const VIDEO_EXT = /\.(mp4|mkv|mov)$/i;

function safeBasename(name: string): string {
  const base = path.basename(name).replace(/[^\w.-]+/g, '_');
  return base || 'upload';
}

export function tusdDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    (env.TUSD_DATA_DIR || '').trim() ||
    path.join((env.MEDIA_HOST_ROOT || '/mnt').trim() || '/mnt', 'tus-uploads')
  );
}

/**
 * Resolve a completed tusd upload to a move target inside the inbox.
 * Throws on anything that is not a finished filestore upload confined to
 * TUSD_DATA_DIR — the hook endpoint must never move arbitrary paths.
 */
export function planTusIntake(
  payload: TusHookPayload,
  env: NodeJS.ProcessEnv = process.env,
): TusIntakePlan | null {
  if (payload?.type !== 'post-finish') return null;
  const upload = payload.event?.upload;
  const storagePath = (upload?.storage?.path || '').trim();
  if (!upload?.id || !storagePath || upload?.storage?.type !== 'filestore') {
    throw new Error('tus hook: missing upload id or filestore path');
  }

  const dataDir = path.resolve(tusdDataDir(env));
  const resolved = path.resolve(storagePath);
  if (!resolved.startsWith(`${dataDir}${path.sep}`)) {
    throw new Error(`tus hook: path ${resolved} outside ${dataDir}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`tus hook: upload file missing at ${resolved}`);
  }

  const meta = upload.meta_data || upload.metadata || {};
  const ext = path.extname(resolved) || path.extname(meta.filename || '') || '.mp4';
  if (!VIDEO_EXT.test(ext)) {
    throw new Error(`tus hook: unsupported extension ${ext}`);
  }

  const pipelineMode: PipelineMode =
    meta.pipelineMode === 'full_ladder' ? 'full_ladder' : 'fast_lane';
  const videoIdHint = meta.videoId && SAFE_ID.test(meta.videoId) ? meta.videoId : undefined;
  const destBasename = videoIdHint
    ? `${videoIdHint}${ext}`
    : `${safeBasename(meta.filename || upload.id)}`;
  const destPath = path.join(resolveInboxDir(pipelineMode, env), destBasename);
  return { srcPath: resolved, destPath, destBasename, pipelineMode, videoIdHint };
}
