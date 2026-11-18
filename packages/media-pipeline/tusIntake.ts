/**
 * TUS upload intake — maps a tusd post-finish hook payload to a move into the
 * pipeline watchfolders. The watchfolder then assigns the video ID exactly as
 * it does for NAS-dropped files (or honors MetaData.videoId verbatim).
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveInboxDir } from './inboxDirs.js';
import type { PipelineMode } from './pipelineMode.js';

/** Native tusd hook payload (capitalized) plus a lowercase-tolerant view. */
export type TusHookPayload = {
  type?: string;
  Type?: string;
  event?: { upload?: TusUpload };
  Event?: { Upload?: TusUpload };
};
type TusUpload = {
  id?: string;
  ID?: string;
  size?: number;
  meta_data?: Record<string, string>;
  metadata?: Record<string, string>;
  MetaData?: Record<string, string>;
  storage?: { type?: string; path?: string; Type?: string; Path?: string };
  Storage?: { type?: string; path?: string; Type?: string; Path?: string };
};

export type TusIntakePlan = {
  srcPath: string;
  destPath: string;
  destBasename: string;
  pipelineMode: PipelineMode;
  videoIdHint?: string;
};

// Only honor a MetaData.videoId hint the watcher will keep verbatim — a hint
// that gets renamed or re-encoded loses the upload↔video association.
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_SAFE_STEM = /^[a-z0-9-]{1,200}$/;

function watcherPreservesStem(stem: string, env: NodeJS.ProcessEnv): boolean {
  const strategy = (env.VIDEO_ID_STRATEGY || 'random').trim();
  if (strategy !== 'filename') {
    // random strategy renames everything EXCEPT UUID stems, which are used
    // verbatim (resolveInputTargetPath 'already_uuid').
    return UUID_LIKE.test(stem);
  }
  const mode = (env.VIDEO_ID_SANITIZE_MODE || 'slug-hash').trim();
  // base64url re-encodes every stem; none passes any stem through verbatim.
  if (mode === 'base64url') return false;
  if (mode === 'none') {
    // Verbatim pass-through — still must be a single safe filename.
    return stem === path.basename(stem) && stem !== '..' && stem.length <= 200;
  }
  // slug and slug-hash keep already-slug-safe stems unchanged (UUIDs included).
  return SLUG_SAFE_STEM.test(stem);
}
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
  const eventType = payload?.type ?? payload?.Type;
  if (eventType !== 'post-finish') return null;
  const upload = payload.event?.upload ?? payload.Event?.Upload;
  const storage = upload?.storage ?? upload?.Storage;
  const storagePath = (storage?.path ?? storage?.Path ?? '').trim();
  const uploadId = upload?.id ?? upload?.ID;
  const storageType = storage?.type ?? storage?.Type;
  if (!uploadId || !storagePath || storageType !== 'filestore') {
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

  const meta = upload?.meta_data ?? upload?.metadata ?? upload?.MetaData ?? {};
  const originalName = path.basename(meta.filename || '');
  let ext = path.extname(resolved) || path.extname(originalName) || '.mp4';
  if (!VIDEO_EXT.test(ext)) {
    throw new Error(`tus hook: unsupported extension ${ext}`);
  }
  ext = ext.toLowerCase();

  const pipelineMode: PipelineMode =
    meta.pipelineMode === 'full_ladder' ? 'full_ladder' : 'fast_lane';
  if (meta.videoId && !watcherPreservesStem(meta.videoId, env)) {
    throw new Error(`tus hook: unsupported videoId hint ${JSON.stringify(meta.videoId)}`);
  }
  const videoIdHint = meta.videoId || undefined;
  // No hint: name by the unique upload id so same-named files can't collide.
  // Bound the stem so the full basename stays under the 255-byte FS limit.
  let destBasename: string;
  if (videoIdHint) {
    destBasename = `${videoIdHint}${ext}`;
  } else {
    const suffix = `-${safeBasename(uploadId)}${ext}`;
    const stem = (safeBasename(originalName.replace(/\.[^.]+$/, '')) || 'upload').slice(
      0,
      Math.max(1, 255 - suffix.length),
    );
    destBasename = `${stem}${suffix}`;
  }
  const destPath = path.join(resolveInboxDir(pipelineMode, env), destBasename);
  return { srcPath: resolved, destPath, destBasename, pipelineMode, videoIdHint };
}
