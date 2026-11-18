import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { planTusIntake } from '../tusIntake.js';

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tus-'));
  tmpDirs.push(dir);
  return dir;
}

function envWith(dir: string): NodeJS.ProcessEnv {
  return {
    TUSD_DATA_DIR: dir,
    INBOX_FAST_LANE_DIR: `${dir}/inbox-fast`,
    INBOX_FULL_LADDER_DIR: `${dir}/inbox-full`,
  };
}

describe('planTusIntake', () => {
  it('ignores non post-finish hooks', () => {
    assert.equal(planTusIntake({ type: 'pre-create' }), null);
  });

  it('plans a rename into the matching inbox', () => {
    const dir = tmpDir();
    const src = path.join(dir, 'upload-1');
    fs.writeFileSync(src, 'x');
    const plan = planTusIntake(
      {
        type: 'post-finish',
        event: {
          upload: {
            id: 'upload-1',
            meta_data: {
              filename: 'my movie.mp4',
              videoId: '550e8400-e29b-41d4-a716-446655440009',
              pipelineMode: 'full_ladder',
            },
            storage: { type: 'filestore', path: src },
          },
        },
      },
      envWith(dir),
    );
    assert.equal(plan?.pipelineMode, 'full_ladder');
    assert.equal(plan?.destPath, `${dir}/inbox-full/550e8400-e29b-41d4-a716-446655440009.mp4`);
  });

  it('accepts native tusd capitalization (Type/Event.Upload/MetaData/Storage)', () => {
    const dir = tmpDir();
    const src = path.join(dir, 'upload-2');
    fs.writeFileSync(src, 'x');
    const plan = planTusIntake(
      {
        Type: 'post-finish',
        Event: {
          Upload: {
            ID: 'upload-2',
            MetaData: { filename: 'clip.mp4', videoId: '550e8400-e29b-41d4-a716-446655440010' },
            Storage: { Type: 'filestore', Path: src },
          },
        },
      },
      envWith(dir),
    );
    assert.equal(plan?.videoIdHint, '550e8400-e29b-41d4-a716-446655440010');
    assert.equal(plan?.destBasename, '550e8400-e29b-41d4-a716-446655440010.mp4');
  });

  it('rejects non-UUID videoId hints the watcher would rename', () => {
    const dir = tmpDir();
    const src = path.join(dir, 'upload-x');
    fs.writeFileSync(src, 'x');
    assert.throws(
      () =>
        planTusIntake(
          {
            Type: 'post-finish',
            Event: {
              Upload: {
                ID: 'upload-x',
                MetaData: { filename: 'clip.mp4', videoId: 'vid-10' },
                Storage: { Type: 'filestore', Path: src },
              },
            },
          },
          envWith(dir),
        ),
      /unsupported videoId hint/,
    );
  });

  it('suffixes the upload id when no videoId hint is given', () => {
    const dir = tmpDir();
    const src = path.join(dir, 'upload-3');
    fs.writeFileSync(src, 'x');
    const plan = planTusIntake(
      {
        type: 'post-finish',
        event: {
          upload: {
            id: 'abc123',
            meta_data: { filename: 'same.mp4' },
            storage: { type: 'filestore', path: src },
          },
        },
      },
      envWith(dir),
    );
    assert.equal(plan?.destBasename, 'same-abc123.mp4');
  });

  it('rejects paths outside TUSD_DATA_DIR', () => {
    const dir = tmpDir();
    const src = path.join(dir, 'upload-1');
    fs.writeFileSync(src, 'x');
    assert.throws(
      () =>
        planTusIntake(
          {
            type: 'post-finish',
            event: {
              upload: {
                id: 'upload-1',
                storage: { type: 'filestore', path: `${dir}-evil/x.mp4` },
              },
            },
          },
          envWith(dir),
        ),
      /outside/,
    );
  });

  it('rejects unsupported extensions', () => {
    const dir = tmpDir();
    const src = path.join(dir, 'evil.exe');
    fs.writeFileSync(src, 'x');
    assert.throws(
      () =>
        planTusIntake(
          {
            type: 'post-finish',
            event: { upload: { id: 'u', storage: { type: 'filestore', path: src } } },
          },
          envWith(dir),
        ),
      /unsupported extension/,
    );
  });

  it('ignores partial uploads of a concatenation sequence', () => {
    const dir = tmpDir();
    const src = path.join(dir, 'part-1');
    fs.writeFileSync(src, 'x');
    const payload = {
      Type: 'post-finish',
      Event: {
        Upload: {
          ID: 'part-1',
          IsPartial: true,
          Storage: { Type: 'filestore', Path: src },
        },
      },
    };
    assert.equal(planTusIntake(payload, envWith(dir)), null);
    // And the final assembled upload (IsPartial absent/false) still plans.
    const finalPayload = {
      Type: 'post-finish',
      Event: {
        Upload: {
          ID: 'final-1',
          IsPartial: false,
          Storage: { Type: 'filestore', Path: src },
        },
      },
    };
    assert.ok(planTusIntake(finalPayload, envWith(dir)));
  });

  it("rejects '.' videoId under sanitize-mode none (hidden '..mp4' vector)", () => {
    const dir = tmpDir();
    const src = path.join(dir, 'u-dot');
    fs.writeFileSync(src, 'x');
    assert.throws(
      () =>
        planTusIntake(
          {
            type: 'post-finish',
            event: {
              upload: {
                id: 'u-dot',
                meta_data: { videoId: '.' },
                storage: { type: 'filestore', path: src },
              },
            },
          },
          { ...envWith(dir), VIDEO_ID_STRATEGY: 'filename', VIDEO_ID_SANITIZE_MODE: 'none' },
        ),
      /videoId hint/,
    );
  });

  it('rejects hints the slug transform would rewrite (double dashes)', () => {
    const dir = tmpDir();
    const src = path.join(dir, 'u-slug');
    fs.writeFileSync(src, 'x');
    const env = {
      ...envWith(dir),
      VIDEO_ID_STRATEGY: 'filename',
      VIDEO_ID_SANITIZE_MODE: 'slug',
    };
    const hook = (videoId: string) => ({
      type: 'post-finish',
      event: {
        upload: {
          id: 'u-slug',
          meta_data: { videoId },
          storage: { type: 'filestore', path: src },
        },
      },
    });
    // 'a--b' slugifies to 'a-b' → watcher renames → hint lost → reject.
    assert.throws(() => planTusIntake(hook('a--b'), env), /videoId hint/);
    // Already-slugged stems pass through untouched.
    assert.ok(planTusIntake(hook('a-b'), env));
    // slug-hash keeps /^[a-z0-9-]+$/ verbatim — 'a--b' stays under that mode.
    assert.ok(
      planTusIntake(hook('a--b'), { ...env, VIDEO_ID_SANITIZE_MODE: 'slug-hash' }),
    );
  });

  it('rejects videoId hints whose basename exceeds 255 bytes', () => {
    const dir = tmpDir();
    const src = path.join(dir, 'u-long');
    fs.writeFileSync(src, 'x');
    // '가' is 3 bytes UTF-8 — 90 × 3 + '.mp4' = 274 bytes → over.
    const tooLong = '가'.repeat(90);
    assert.throws(
      () =>
        planTusIntake(
          {
            type: 'post-finish',
            event: {
              upload: {
                id: 'u-long',
                meta_data: { videoId: tooLong },
                storage: { type: 'filestore', path: src },
              },
            },
          },
          { ...envWith(dir), VIDEO_ID_STRATEGY: 'filename', VIDEO_ID_SANITIZE_MODE: 'none' },
        ),
      /too long|videoId hint/,
    );
  });
});
