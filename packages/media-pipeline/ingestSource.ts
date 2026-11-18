import path from 'node:path';
import { resolveInboxDir } from './inboxDirs.js';
import type { PipelineMode } from './pipelineMode.js';

/**
 * Planning for POST /vmp/api/ingest: the API asks the pipeline to pull a raw
 * upload (videos/{id}/source.*) through its /api/video-proxy route and drop it
 * into the watchfolder inbox, so remote uploads ride the same encode flow as
 * NAS drops without paying direct B2 egress.
 *
 * Security: the source URL must be https on the configured API origin and
 * point inside videos/{videoId}/ — anything else is rejected before fetch.
 */

export class IngestPlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type IngestPlan = {
  videoId: string;
  pipelineMode: PipelineMode;
  fetchUrl: string;
  destPath: string;
  destBasename: string;
};

const SAFE_ID = /^[a-zA-Z0-9._-]+$/;
const SAFE_EXT = /\.(mp4|mov|mkv)$/i;
const PROXY_PREFIX = '/api/video-proxy/';

export function planIngest(
  payload: { event?: unknown; videoId?: unknown; pipelineMode?: unknown; sourceUrl?: unknown },
  apiBaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): IngestPlan {
  if (payload?.event !== 'ingest_source') {
    throw new IngestPlanError('invalid_event', 'expected event ingest_source');
  }
  const videoId = String(payload?.videoId || '').trim();
  if (!videoId || videoId.length > 128 || !SAFE_ID.test(videoId)) {
    throw new IngestPlanError('invalid_video_id', 'videoId must be a safe identifier');
  }
  const pipelineMode: PipelineMode =
    payload?.pipelineMode === 'full_ladder' ? 'full_ladder' : 'fast_lane';

  const base = apiBaseUrl.trim().replace(/\/+$/, '');
  if (!base) {
    throw new IngestPlanError('ingest_not_configured', 'VMP_API_BASE_URL is not configured');
  }
  let allowed: URL;
  try {
    allowed = new URL(base);
  } catch {
    throw new IngestPlanError('ingest_not_configured', 'VMP_API_BASE_URL is not a valid URL');
  }

  let source: URL;
  try {
    source = new URL(String(payload?.sourceUrl || ''));
  } catch {
    throw new IngestPlanError('invalid_source_url', 'sourceUrl is not a valid URL');
  }
  if (source.protocol !== 'https:' && source.protocol !== 'http:') {
    throw new IngestPlanError('invalid_source_url', 'sourceUrl must be http(s)');
  }
  if (source.origin !== allowed.origin) {
    throw new IngestPlanError(
      'source_origin_denied',
      'sourceUrl origin must match VMP_API_BASE_URL',
    );
  }
  const objectPath = source.pathname.startsWith(PROXY_PREFIX)
    ? decodeURIComponent(source.pathname.slice(PROXY_PREFIX.length))
    : '';
  if (!objectPath.startsWith(`videos/${videoId}/`) || !SAFE_EXT.test(objectPath)) {
    throw new IngestPlanError(
      'invalid_source_key',
      `sourceUrl must resolve to videos/${videoId}/source.{mp4,mov,mkv}`,
    );
  }

  const ext = SAFE_EXT.exec(objectPath)?.[0] ?? '.mp4';
  const destBasename = `${videoId}${ext.toLowerCase()}`;
  const destPath = path.join(resolveInboxDir(pipelineMode, env), destBasename);
  return { videoId, pipelineMode, fetchUrl: source.toString(), destPath, destBasename };
}
