import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encorePriorityFor, encoreQueueForPriority } from '../encorePriorities.js';

describe('encorePriorities', () => {
  it('maps GPU-class jobs to queue 0 and CPU-class to queue 1', () => {
    assert.equal(encoreQueueForPriority(encorePriorityFor('fast_lane', 'gpu')), 0);
    assert.equal(encoreQueueForPriority(encorePriorityFor('full_ladder', 'gpu')), 0);
    assert.equal(encoreQueueForPriority(encorePriorityFor('fast_lane', 'cpu')), 1);
    assert.equal(encoreQueueForPriority(encorePriorityFor('full_ladder', 'cpu')), 1);
    assert.equal(encoreQueueForPriority(encorePriorityFor('podcast', 'cpu')), 1);
    assert.equal(encoreQueueForPriority(encorePriorityFor('preview_mp3', 'cpu')), 1);
  });

  it('keeps GPU fast-lane ahead of GPU ladders and CPU fast-lane ahead of CPU ladders', () => {
    assert.ok(
      encorePriorityFor('fast_lane', 'gpu') > encorePriorityFor('full_ladder', 'gpu'),
      'fast lane should outrank ladder within GPU class',
    );
    assert.ok(
      encorePriorityFor('fast_lane', 'cpu') > encorePriorityFor('full_ladder', 'cpu'),
      'fast lane should outrank ladder within CPU class',
    );
    assert.ok(
      encorePriorityFor('full_ladder', 'cpu') > encorePriorityFor('preview_mp3', 'cpu'),
      'ladder should outrank podcast work',
    );
  });

  it('uses priority 50 as the GPU-class boundary', () => {
    assert.equal(encoreQueueForPriority(50), 0);
    assert.equal(encoreQueueForPriority(49), 1);
  });
});
