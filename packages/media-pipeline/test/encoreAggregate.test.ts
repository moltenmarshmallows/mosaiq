import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AggregateJobRecord,
  aggregateJobIdFor,
  buildAggregateEncoreJobDoc,
} from '../encoreAggregate.js';
import type { EncoreJob } from '../encoreClient.js';

function member(id: string, status = 'SUCCESSFUL'): EncoreJob {
  return {
    id,
    status,
    outputFolder: '/media/encore-out',
    output: [
      { type: 'Video', file: `${id}/video.mp4`, fileSize: 100 } as EncoreJob['output'][number],
    ],
  } as EncoreJob;
}

const record: AggregateJobRecord = {
  jobId: 'agg-v1',
  videoId: 'v1',
  inputUri: '/media/src/v1.mp4',
  memberJobIds: ['j1', 'j2', 'j3'],
};

describe('buildAggregateEncoreJobDoc', () => {
  it('merges outputs of all member jobs into one doc', () => {
    const doc = buildAggregateEncoreJobDoc(record, [member('j1'), member('j2'), member('j3')]);
    assert.equal(doc.id, 'agg-v1');
    assert.equal(doc.status, 'SUCCESSFUL');
    assert.equal((doc.output as unknown[]).length, 3);
    assert.equal((doc.inputs as { uri: string }[])[0].uri, '/media/src/v1.mp4');
    // The stock packager packages every output — assert they are the member
    // renditions, not just a count.
    const files = (doc.output as { file: string }[]).map((o) => o.file);
    assert.deepEqual(files, ['j1/video.mp4', 'j2/video.mp4', 'j3/video.mp4']);
    assert.ok((doc.output as { type: string }[]).every((o) => o.type === 'Video'));
  });

  it('fails when a member is unfinished rather than producing a partial ladder', () => {
    assert.throws(
      () =>
        buildAggregateEncoreJobDoc(record, [
          member('j1'),
          member('j2', 'IN_PROGRESS'),
          member('j3'),
        ]),
      /status=IN_PROGRESS/,
    );
  });

  it('fails when a member has no outputs', () => {
    const empty = { ...member('j2'), output: [] } as EncoreJob;
    assert.throws(
      () => buildAggregateEncoreJobDoc(record, [member('j1'), empty, member('j3')]),
      /no outputs/,
    );
  });

  it('fails when member count mismatches', () => {
    assert.throws(
      () => buildAggregateEncoreJobDoc(record, [member('j1')]),
      /expected 3 member jobs/,
    );
  });
});

describe('aggregateJobIdFor', () => {
  it('prefixes the video id', () => {
    assert.match(aggregateJobIdFor('abc'), /^agg-abc-[0-9a-f]{8}$/);
    // Each attempt must get a distinct id so a retry can't collide with a
    // still-running prior packaging attempt.
    assert.notEqual(aggregateJobIdFor('abc'), aggregateJobIdFor('abc'));
  });
});
