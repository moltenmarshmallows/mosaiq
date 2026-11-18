import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IngestPlanError, planIngest } from '../ingestSource.js';

const API = 'https://staging.app.mosaiq.video';
const env = { INBOX_FAST_LANE_DIR: '/inbox/fast', INBOX_FULL_LADDER_DIR: '/inbox/full' };

const valid = {
  event: 'ingest_source',
  videoId: '550e8400-e29b-41d4-a716-446655440000',
  sourceUrl: `${API}/api/video-proxy/videos/550e8400-e29b-41d4-a716-446655440000/source.mp4?vt=tok`,
};

test('accepts a valid ingest payload for the fast-lane inbox', () => {
  const plan = planIngest(valid, API, env);
  assert.equal(plan.videoId, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(plan.pipelineMode, 'fast_lane');
  assert.equal(plan.destPath, '/inbox/fast/550e8400-e29b-41d4-a716-446655440000.mp4');
});

test('routes full_ladder mode to the full-ladder inbox', () => {
  const plan = planIngest({ ...valid, pipelineMode: 'full_ladder' }, API, env);
  assert.equal(plan.destPath, '/inbox/full/550e8400-e29b-41d4-a716-446655440000.mp4');
});

test('preserves the source extension', () => {
  const plan = planIngest(
    { ...valid, sourceUrl: `${API}/api/video-proxy/videos/550e8400-e29b-41d4-a716-446655440000/source.MOV` },
    API,
    env,
  );
  assert.equal(plan.destBasename, '550e8400-e29b-41d4-a716-446655440000.mov');
});

test('rejects a foreign origin (SSRF)', () => {
  assert.throws(
    () =>
      planIngest(
        {
          ...valid,
          sourceUrl: 'https://evil.example.com/api/video-proxy/videos/550e8400-e29b-41d4-a716-446655440000/source.mp4',
        },
        API,
        env,
      ),
    (e: unknown) => e instanceof IngestPlanError && e.code === 'source_origin_denied',
  );
});

test('rejects object keys outside videos/{id}/', () => {
  assert.throws(
    () =>
      planIngest(
        { ...valid, sourceUrl: `${API}/api/video-proxy/secrets/550e8400-e29b-41d4-a716-446655440000/source.mp4` },
        API,
        env,
      ),
    (e: unknown) => e instanceof IngestPlanError && e.code === 'invalid_source_key',
  );
});

test('rejects key spoofed to a different videoId', () => {
  assert.throws(
    () =>
      planIngest(
        { ...valid, sourceUrl: `${API}/api/video-proxy/videos/other-id/source.mp4` },
        API,
        env,
      ),
    (e: unknown) => e instanceof IngestPlanError && e.code === 'invalid_source_key',
  );
});

test('rejects non-video extensions', () => {
  assert.throws(
    () =>
      planIngest(
        { ...valid, sourceUrl: `${API}/api/video-proxy/videos/550e8400-e29b-41d4-a716-446655440000/source.exe` },
        API,
        env,
      ),
    (e: unknown) => e instanceof IngestPlanError && e.code === 'invalid_source_key',
  );
});

test('rejects unsafe videoIds and wrong events', () => {
  assert.throws(
    () => planIngest({ ...valid, videoId: '../etc' }, API, env),
    (e: unknown) => e instanceof IngestPlanError && e.code === 'invalid_video_id',
  );
  assert.throws(() => planIngest({ ...valid, event: 'other' }, API, env), IngestPlanError);
});

test('rejects a videoId the watcher would rename (non-UUID under random)', () => {
  // Default strategy is 'random': only UUID stems survive verbatim — anything
  // else lands in the inbox then gets renamed, losing the upload↔video link.
  assert.throws(
    () => planIngest({ ...valid, videoId: 'not-a-uuid-123' }, API, env),
    (e: unknown) => e instanceof IngestPlanError && e.code === 'invalid_video_id',
  );
  // But under filename+slug-hash a slug-safe stem is preserved → accepted.
  const plan = planIngest(
    {
      ...valid,
      videoId: 'my-clip-01',
      sourceUrl: `${API}/api/video-proxy/videos/my-clip-01/source.mp4`,
    },
    API,
    { ...env, VIDEO_ID_STRATEGY: 'filename', VIDEO_ID_SANITIZE_MODE: 'slug-hash' },
  );
  assert.equal(plan.destBasename, 'my-clip-01.mp4');
});

test('rejects when VMP_API_BASE_URL is unset', () => {
  assert.throws(
    () => planIngest(valid, '', env),
    (e: unknown) => e instanceof IngestPlanError && e.code === 'ingest_not_configured',
  );
});

// Transport policy: matching origins are required so each case isolates scheme.
// A non-loopback http source can never be exercised — its API base would fail
// first — so coverage is loopback-accept + non-loopback-base-reject.
test('accepts loopback http for local development', () => {
  const api = 'http://127.0.0.1:8788';
  const plan = planIngest(
    { ...valid, sourceUrl: `${api}/api/video-proxy/videos/550e8400-e29b-41d4-a716-446655440000/source.mp4` },
    api,
    env,
  );
  assert.equal(plan.videoId, '550e8400-e29b-41d4-a716-446655440000');
});

test('rejects a non-loopback http VMP_API_BASE_URL', () => {
  assert.throws(
    () => planIngest(valid, 'http://api.internal', env),
    (e: unknown) => e instanceof IngestPlanError && e.code === 'ingest_not_configured',
  );
});
