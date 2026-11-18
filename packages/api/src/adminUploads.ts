/**
 * Admin video uploads — browser-direct S3 multipart into B2 at
 * `videos/{id}/source.{ext}`. The raw file is playable through the existing
 * /api/video-proxy path the moment the upload completes; the media pipeline
 * is then told to pull it via that same proxy URL (B2→CF = free egress) and
 * replaces progressive playback with HLS when ready.
 *
 * Endpoints (editor/admin/super_admin):
 *   POST /api/admin/videos/uploads                    → draft video + upload session
 *   GET  /api/admin/videos/uploads/:videoId/part      → presigned part PUT URL
 *   POST /api/admin/videos/uploads/:videoId/complete  → finish + notify pipeline
 *   POST /api/admin/videos/uploads/:videoId/abort     → cancel session
 *
 * Ingest delivery derives the supervisor origin + shared secret from the
 * podcast_rebuild_webhook_url/_secret admin settings — if those are unset the
 * upload still completes (raw file stays playable) but nothing encodes.
 */

import type { ObjectStorageProvider } from '@vmp/storage/worker';
import { requireRole } from './auth.js';
import { getObjectStorage } from './objectStorage.js';
import { hmacSha256Hex } from './rssPodcastAdmin.js';
import { getSetting } from './settingsStore.js';
import { signVideoToken } from './videoTokens.js';

const RAW_EXT_RE = /\.(mp4|mov|mkv)$/i;
const PART_SIZE = 16 * 1024 * 1024;
const INGEST_TOKEN_TTL_SECONDS = 6 * 3600;

function jsonResponse(data: unknown, status = 200, corsHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function getDb(env: any) {
  const db = env.DB || env.video_subscription_db;
  if (!db) throw new Error('D1 binding not found');
  return db;
}

async function requireEditor(request: Request, env: any, corsHeaders: any) {
  try {
    await requireRole(request, env, 'editor', 'admin', 'super_admin');
  } catch {
    return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);
  }
  return null;
}

type MultipartStorage = ObjectStorageProvider &
  Required<
    Pick<
      ObjectStorageProvider,
      | 'createMultipartUpload'
      | 'getSignedUploadPartUrl'
      | 'completeMultipartUpload'
      | 'abortMultipartUpload'
    >
  >;

function storageOrNull(env: any): MultipartStorage | null {
  const storage = getObjectStorage(env);
  if (
    !storage?.createMultipartUpload ||
    !storage.getSignedUploadPartUrl ||
    !storage.completeMultipartUpload ||
    !storage.abortMultipartUpload
  ) {
    return null;
  }
  return storage as MultipartStorage;
}

async function getVideoUploadState(env: any, videoId: string) {
  const row = (await getDb(env)
    .prepare('SELECT id, raw_source_key, status FROM videos WHERE id = ?')
    .bind(videoId)
    .first()) as { id?: string; raw_source_key?: string | null; status?: string } | null;
  if (!row?.id) return null;
  return row;
}

/** POST /api/admin/videos/uploads — create draft video + multipart session. */
export async function handleAdminUploadCreate(request: Request, env: any, corsHeaders: any) {
  const authError = await requireEditor(request, env, corsHeaders);
  if (authError) return authError;
  const storage = storageOrNull(env);
  if (!storage) {
    return jsonResponse(
      { error: 'Object storage does not support multipart uploads', code: 'storage_unsupported' },
      503,
      corsHeaders,
    );
  }
  const body = (await request.json().catch(() => null)) as {
    filename?: string;
    title?: string;
    pipelineMode?: string;
  } | null;
  const filename = String(body?.filename || '').trim();
  const ext = RAW_EXT_RE.exec(filename)?.[0]?.toLowerCase();
  if (!ext) {
    return jsonResponse({ error: 'filename must end in .mp4, .mov or .mkv' }, 400, corsHeaders);
  }
  const pipelineMode = body?.pipelineMode === 'full_ladder' ? 'full_ladder' : 'fast_lane';
  const videoId = crypto.randomUUID();
  const key = `videos/${videoId}/source${ext}`;
  const title =
    String(body?.title || '').trim() || filename.replace(RAW_EXT_RE, '').trim() || videoId;

  const uploadId = await storage.createMultipartUpload(key);
  try {
    await getDb(env)
      .prepare(
        `INSERT INTO videos (id, title, description, full_duration, preview_duration, status, publish_status, slug, raw_source_key, upload_date, updated_at)
         VALUES (?, ?, '', 0, 0, 'processing', 'draft', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(videoId, title, `raw-${crypto.randomUUID().slice(0, 8)}`, key)
      .run();
  } catch (err) {
    // Don't leak an untracked multipart session nobody can abort.
    await storage.abortMultipartUpload(key, uploadId).catch(() => {});
    throw err;
  }

  return jsonResponse(
    { videoId, key, uploadId, partSize: PART_SIZE, pipelineMode },
    201,
    corsHeaders,
  );
}

/** GET …/part — presign one UploadPart PUT (B2 supports presigned parts). */
export async function handleAdminUploadPartSign(request: Request, env: any, corsHeaders: any) {
  const authError = await requireEditor(request, env, corsHeaders);
  if (authError) return authError;
  const storage = storageOrNull(env);
  if (!storage?.getSignedUploadPartUrl) {
    return jsonResponse(
      { error: 'Multipart unsupported', code: 'storage_unsupported' },
      503,
      corsHeaders,
    );
  }
  const url = new URL(request.url);
  const videoId = url.pathname.split('/').at(-2) || '';
  const uploadId = url.searchParams.get('uploadId') || '';
  const partNumber = Number(url.searchParams.get('partNumber'));
  if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return jsonResponse({ error: 'uploadId and partNumber (1..10000) required' }, 400, corsHeaders);
  }
  const video = await getVideoUploadState(env, videoId);
  const key = video?.raw_source_key;
  if (!key) {
    return jsonResponse({ error: 'Upload session not found', code: 'not_found' }, 404, corsHeaders);
  }
  const signed = await storage.getSignedUploadPartUrl(key, uploadId, partNumber);
  return jsonResponse({ url: signed, partNumber }, 200, corsHeaders);
}

/** POST …/complete — finish multipart, mark processing, notify pipeline. */
export async function handleAdminUploadComplete(request: Request, env: any, corsHeaders: any) {
  const authError = await requireEditor(request, env, corsHeaders);
  if (authError) return authError;
  const storage = storageOrNull(env);
  if (!storage) {
    return jsonResponse(
      { error: 'Multipart unsupported', code: 'storage_unsupported' },
      503,
      corsHeaders,
    );
  }
  const videoId = new URL(request.url).pathname.split('/').at(-2) || '';
  const body = (await request.json().catch(() => null)) as {
    uploadId?: string;
    pipelineMode?: string;
    parts?: { partNumber?: number; etag?: string }[];
  } | null;
  const parts = Array.isArray(body?.parts)
    ? body!.parts
        .filter((p) => Number.isInteger(p?.partNumber) && typeof p?.etag === 'string')
        .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }))
        .sort((a, b) => a.partNumber - b.partNumber)
    : [];
  if (!body?.uploadId || parts.length === 0) {
    return jsonResponse({ error: 'uploadId and parts[] required' }, 400, corsHeaders);
  }
  const video = await getVideoUploadState(env, videoId);
  const key = video?.raw_source_key;
  if (!key) {
    return jsonResponse({ error: 'Upload session not found', code: 'not_found' }, 404, corsHeaders);
  }

  let head = await storage.headObject(key);
  if (!head?.size) {
    try {
      await storage.completeMultipartUpload(key, body.uploadId, parts);
    } catch (err) {
      // Retry after a committed upload → NoSuchUpload. Re-check the object and
      // continue if B2 already committed it.
      head = await storage.headObject(key);
      if (!head?.size) throw err;
    }
    head = head ?? (await storage.headObject(key));
  }
  if (!head?.size) {
    return jsonResponse({ error: 'Uploaded object missing after complete' }, 502, corsHeaders);
  }

  const pipelineMode = body?.pipelineMode === 'full_ladder' ? 'full_ladder' : 'fast_lane';
  await getDb(env)
    .prepare(`UPDATE videos SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(videoId)
    .run();

  const ingest = await deliverIngestWebhook(request, env, videoId, key, pipelineMode);
  return jsonResponse({ ok: ingest.delivered, videoId, bytes: head.size, ingest }, 200, corsHeaders);
}

/** POST …/ingest — re-notify the pipeline for an already-committed source. */
export async function handleAdminUploadIngest(request: Request, env: any, corsHeaders: any) {
  const authError = await requireEditor(request, env, corsHeaders);
  if (authError) return authError;
  const videoId = new URL(request.url).pathname.split('/').at(-2) || '';
  const video = await getVideoUploadState(env, videoId);
  const key = video?.raw_source_key;
  if (!key) {
    return jsonResponse({ error: 'No raw source to ingest', code: 'not_found' }, 404, corsHeaders);
  }
  if (video?.status === 'processed') {
    return jsonResponse({ error: 'Video already processed' }, 409, corsHeaders);
  }
  const body = (await request.json().catch(() => null)) as { pipelineMode?: string } | null;
  const ingest = await deliverIngestWebhook(request, env, videoId, key, body?.pipelineMode || 'fast_lane');
  return jsonResponse(
    { ok: ingest.delivered, ingest },
    ingest.delivered ? 200 : 502,
    corsHeaders,
  );
}

/** POST …/abort — cancel the multipart session and detach the raw key. */
export async function handleAdminUploadAbort(request: Request, env: any, corsHeaders: any) {
  const authError = await requireEditor(request, env, corsHeaders);
  if (authError) return authError;
  const storage = storageOrNull(env);
  const videoId = new URL(request.url).pathname.split('/').at(-2) || '';
  const body = (await request.json().catch(() => null)) as { uploadId?: string } | null;
  if (!body?.uploadId) {
    return jsonResponse({ error: 'uploadId required' }, 400, corsHeaders);
  }
  const video = await getVideoUploadState(env, videoId);
  if (!video?.raw_source_key) {
    return jsonResponse({ error: 'Upload session not found', code: 'not_found' }, 404, corsHeaders);
  }
  // A completed upload is the playable source — refuse to detach it.
  const head = await storage?.headObject(video.raw_source_key).catch(() => null);
  if (head?.size) {
    return jsonResponse(
      { error: 'Upload already completed; abort would orphan the playable source', code: 'already_completed' },
      409,
      corsHeaders,
    );
  }
  if (storage?.abortMultipartUpload) {
    try {
      await storage.abortMultipartUpload(video.raw_source_key, body.uploadId);
    } catch {
      return jsonResponse(
        { error: 'Abort failed in storage; session kept for retry', code: 'abort_failed' },
        502,
        corsHeaders,
      );
    }
  }
  await getDb(env)
    .prepare(
      `UPDATE videos SET raw_source_key = NULL, status = 'draft', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    )
    .bind(videoId)
    .run();
  return jsonResponse({ ok: true }, 200, corsHeaders);
}

/**
 * Tell the supervisor to pull the raw file. The fetch URL goes through
 * /api/video-proxy (B2→Cloudflare = free egress) with a long-lived vt token
 * minted for videoId; the supervisor validates the URL origin before fetching.
 */
async function deliverIngestWebhook(
  request: Request,
  env: any,
  videoId: string,
  key: string,
  pipelineMode: string,
) {
  const webhookUrl = String(
    (await getSetting(env, 'podcast_rebuild_webhook_url', { defaultValue: '' })) ?? '',
  ).trim();
  const secret = String(
    (await getSetting(env, 'podcast_rebuild_webhook_secret', { defaultValue: '' })) ?? '',
  ).trim();
  const jwtSecret = String(env.JWT_SECRET ?? '').trim();
  if (!webhookUrl || !secret || !jwtSecret) {
    return { delivered: false, code: 'ingest_not_configured' };
  }
  let ingestUrl: string;
  try {
    ingestUrl = `${new URL(webhookUrl).origin}/vmp/api/ingest`;
  } catch {
    return { delivered: false, code: 'ingest_url_invalid' };
  }
  const vt = await signVideoToken('anonymous', videoId, jwtSecret, null, {
    ttlSeconds: INGEST_TOKEN_TTL_SECONDS,
  });
  // The supervisor only accepts the origin it knows as VMP_API_BASE_URL — build
  // the source URL from the same canonical value, not the request's hostname.
  const apiOrigin = String(env.VMP_API_BASE_URL || '').trim() || new URL(request.url).origin;
  const sourceUrl = `${apiOrigin.replace(/\/+$/, '')}/api/video-proxy/${key}?vt=${encodeURIComponent(vt)}`;
  const rawBody = JSON.stringify({
    event: 'ingest_source',
    videoId,
    pipelineMode,
    sourceUrl,
    sentAt: new Date().toISOString(),
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await hmacSha256Hex(secret, `${ts}.${rawBody}`);
  try {
    const res = await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VMP-Signature': `sha256=${signature}`,
        'X-VMP-Timestamp': ts,
      },
      body: rawBody,
      redirect: 'error',
    });
    return res.ok
      ? { delivered: true }
      : { delivered: false, code: 'ingest_rejected', status: res.status };
  } catch {
    return { delivered: false, code: 'ingest_unreachable' };
  }
}
