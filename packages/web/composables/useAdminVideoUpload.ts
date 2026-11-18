/**
 * Browser-direct S3 multipart upload of a raw video to B2.
 *
 * Flow: POST /api/admin/videos/uploads → per-part presigned PUTs → complete.
 * The API then tells the media pipeline to pull the file via the video proxy
 * (no direct B2 egress), and the raw file is playable while HLS encodes.
 *
 * Resume: the session (uploadId + finished parts) is kept in localStorage
 * keyed by file name/size, so a failed upload can continue where it stopped.
 */

import type { Ref } from 'vue';

export type AdminUploadProgress = {
  state: 'idle' | 'creating' | 'uploading' | 'completing' | 'done' | 'error';
  bytesSent: number;
  totalBytes: number;
  videoId: string | null;
  error: string | null;
};

type Part = { partNumber: number; etag: string };

type Session = {
  videoId: string;
  uploadId: string;
  partSize: number;
  fileName: string;
  fileSize: number;
  parts: Part[];
};

const LS_PREFIX = 'vmp-upload:';
const CONCURRENCY = 3;
const MAX_PART_RETRIES = 4;

export function useAdminVideoUpload(
  apiUrl: string,
  authHeader: () => Record<string, string>,
  progress: Ref<AdminUploadProgress>,
) {
  const sessionKey = (file: File) => `${LS_PREFIX}${file.name}:${file.size}`;

  const loadSession = (file: File): Session | null => {
    try {
      const raw = localStorage.getItem(sessionKey(file));
      const s = raw ? (JSON.parse(raw) as Session) : null;
      return s && s.fileName === file.name && s.fileSize === file.size ? s : null;
    } catch {
      return null;
    }
  };

  const saveSession = (file: File, s: Session) =>
    localStorage.setItem(sessionKey(file), JSON.stringify(s));
  const clearSession = (file: File) => localStorage.removeItem(sessionKey(file));

  const apiFetch = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...authHeader() },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `Upload API error ${res.status}`);
    }
    return res.json();
  };

  /** PUT one part to the presigned URL; resolves with the part's ETag. */
  const putPart = (url: string, blob: Blob, onProgress: (loaded: number) => void) =>
    new Promise<string>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
      xhr.onload = () => {
        const etag = xhr.getResponseHeader('ETag');
        if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag.replace(/"/g, ''));
        else reject(new Error(`Part upload failed: HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Part upload failed: network error'));
      xhr.send(blob);
    });

  const upload = async (
    file: File,
    opts: { title?: string; pipelineMode?: 'fast_lane' | 'full_ladder' } = {},
  ) => {
    progress.value = {
      state: 'creating',
      bytesSent: 0,
      totalBytes: file.size,
      videoId: null,
      error: null,
    };
    try {
      let session = loadSession(file);
      if (!session) {
        const created = await apiFetch('/api/admin/videos/uploads', {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            title: opts.title,
            pipelineMode: opts.pipelineMode ?? 'fast_lane',
          }),
        });
        session = {
          videoId: created.videoId,
          uploadId: created.uploadId,
          partSize: created.partSize,
          fileName: file.name,
          fileSize: file.size,
          parts: [],
        };
        saveSession(file, session);
      }
      const s = session;
      progress.value = { ...progress.value, state: 'uploading', videoId: s.videoId };

      const partCount = Math.max(1, Math.ceil(file.size / s.partSize));
      const done = new Set(s.parts.map((p) => p.partNumber));
      const inFlight = new Map<number, number>();
      const sent = () =>
        s.parts.reduce(
          (n, p) => n + Math.min(s.partSize, file.size - (p.partNumber - 1) * s.partSize),
          0,
        ) + [...inFlight.values()].reduce((a, b) => a + b, 0);

      const uploadPart = async (partNumber: number) => {
        const blob = file.slice((partNumber - 1) * s.partSize, partNumber * s.partSize);
        for (let attempt = 0; ; attempt++) {
          inFlight.set(partNumber, 0);
          try {
            const { url } = await apiFetch(
              `/api/admin/videos/uploads/${s.videoId}/part?uploadId=${encodeURIComponent(s.uploadId)}&partNumber=${partNumber}`,
            );
            const etag = await putPart(url, blob, (loaded) => {
              inFlight.set(partNumber, loaded);
              progress.value = { ...progress.value, bytesSent: sent() };
            });
            inFlight.delete(partNumber);
            s.parts.push({ partNumber, etag });
            s.parts.sort((a, b) => a.partNumber - b.partNumber);
            saveSession(file, s);
            progress.value = { ...progress.value, bytesSent: sent() };
            return;
          } catch (err) {
            inFlight.delete(partNumber);
            if (attempt >= MAX_PART_RETRIES) throw err;
            await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          }
        }
      };

      // Simple worker-pool over part numbers.
      const pending: number[] = [];
      for (let n = 1; n <= partCount; n++) if (!done.has(n)) pending.push(n);
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, pending.length) }, async () => {
          for (let n = pending.pop(); n !== undefined; n = pending.pop()) {
            await uploadPart(n);
          }
        }),
      );

      progress.value = { ...progress.value, state: 'completing' };
      const completed = await apiFetch(`/api/admin/videos/uploads/${s.videoId}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          uploadId: s.uploadId,
          pipelineMode: opts.pipelineMode ?? 'fast_lane',
          parts: s.parts,
        }),
      });
      clearSession(file);
      progress.value = { ...progress.value, state: 'done', bytesSent: file.size };
      return { videoId: s.videoId, ingestDelivered: completed?.ingest?.delivered !== false };
    } catch (err) {
      progress.value = {
        ...progress.value,
        state: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
      throw err;
    }
  };

  const resume = (file: File) => loadSession(file) !== null;

  const abort = async (file: File) => {
    const s = loadSession(file);
    if (!s) return;
    await apiFetch(`/api/admin/videos/uploads/${s.videoId}/abort`, {
      method: 'POST',
      body: JSON.stringify({ uploadId: s.uploadId }),
    }).catch(() => undefined);
    clearSession(file);
    progress.value = { state: 'idle', bytesSent: 0, totalBytes: 0, videoId: null, error: null };
  };

  return { upload, resume, abort };
}
