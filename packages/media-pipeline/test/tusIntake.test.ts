import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { planTusIntake } from '../tusIntake.js';

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tus-'));
    const src = path.join(dir, 'upload-1');
    fs.writeFileSync(src, 'x');
    const plan = planTusIntake(
      {
        type: 'post-finish',
        event: {
          upload: {
            id: 'upload-1',
            meta_data: { filename: 'my movie.mp4', videoId: 'vid-9', pipelineMode: 'full_ladder' },
            storage: { type: 'filestore', path: src },
          },
        },
      },
      envWith(dir),
    );
    assert.equal(plan?.pipelineMode, 'full_ladder');
    assert.equal(plan?.destPath, `${dir}/inbox-full/vid-9.mp4`);
  });

  it('rejects paths outside TUSD_DATA_DIR', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tus-'));
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tus-'));
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
});
