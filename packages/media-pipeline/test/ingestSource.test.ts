import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IngestPlanError, planIngest } from '../ingestSource.js';

const API = 'https://staging.app.mosaiq.video';
const env = { INBOX_FAST_LANE_DIR: '/inbox/fast', INBOX_FULL_LADDER_DIR: '/inbox/full' };

const valid = {
  event: 'ingest_source',
  videoId: 'abc-123',
  sourceUrl: `${API}/api/video-proxy/videos/abc-123/source.mp4?vt=tok`,
};

test('accepts a valid ingest payload for the fast-lane inbox', () => {
  const plan = planIngest(valid, API, env);
  assert.equal(plan.videoId, 'abc-123');
  assert.equal(plan.pipelineMode, 'fast_lane');
  assert.equal(plan.destPath, '/inbox/fast/abc-123.mp4');
});

test('routes full_ladder mode to the full-ladder inbox', () => {
  const plan = planIngest({ ...valid, pipelineMode: 'full_ladder' }, API, env);
  assert.equal(plan.destPath, '/inbox/full/abc-123.mp4');
});

test('preserves the source extension', () => {
  const plan = planIngest(
    { ...valid, sourceUrl: `${API}/api/video-proxy/videos/abc-123/source.MOV` },
    API,
    env,
  );
  assert.equal(plan.destBasename, 'abc-123.mov');
});

test('rejects a foreign origin (SSRF)', () => {
  assert.throws(
    () =>
      planIngest(
        {
          ...valid,
          sourceUrl: 'https://evil.example.com/api/video-proxy/videos/abc-123/source.mp4',
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
        { ...valid, sourceUrl: `${API}/api/video-proxy/secrets/abc-123/source.mp4` },
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
        { ...valid, sourceUrl: `${API}/api/video-proxy/videos/abc-123/source.exe` },
        API,
        env,
      ),
    (e: unknown) => e instanceof IngestPlanError && e.code === 'invalid_source_key',
  );
});

test('rejects unsafe videoIds and wrong events', () => {
  assert.throws(() => planIngest({ ...valid, videoId: '../etc' }, API, env), IngestPlanError);
  assert.throws(() => planIngest({ ...valid, event: 'other' }, API, env), IngestPlanError);
});

test('rejects when VMP_API_BASE_URL is unset', () => {
  assert.throws(
    () => planIngest(valid, '', env),
    (e: unknown) => e instanceof IngestPlanError && e.code === 'ingest_not_configured',
  );
});
