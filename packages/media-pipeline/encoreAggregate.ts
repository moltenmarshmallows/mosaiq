/**
 * Synthesized Encore job for rendition-split packaging (VMP_LADDER_SPLIT=renditions).
 *
 * encore-packager fetches the job URL from its Redis queue message and
 * packages every entry in `job.output`. When a ladder is encoded as one
 * Encore job per rendition, no single job lists all outputs — so the
 * supervisor serves a merged document at /vmp/api/encoreJobAggregate/:id
 * that the stock packager treats exactly like a real Encore job.
 */

import type { EncoreJob, EncoreJobOutput } from './encoreClient.js';

export const AGGREGATE_JOB_PATH_PREFIX = '/vmp/api/encoreJobAggregate/';

export type AggregateJobRecord = {
  /** Aggregate packaging job id (e.g. `agg-<videoId>`). */
  jobId: string;
  videoId: string;
  /** Encore input URI of the source (as Encore sees it). */
  inputUri: string;
  /** Member Encore job ids whose outputs are merged. */
  memberJobIds: string[];
};

export function aggregateJobIdFor(videoId: string): string {
  return `agg-${videoId}`;
}

/**
 * Merge finished member jobs into one Encore-job-shaped document.
 * Throws if any member is missing, unfinished, or has no outputs — the
 * packager would produce a partial ladder, which is worse than failing.
 */
export function buildAggregateEncoreJobDoc(
  record: AggregateJobRecord,
  memberJobs: EncoreJob[],
): Record<string, unknown> {
  if (memberJobs.length !== record.memberJobIds.length) {
    throw new Error(
      `aggregate ${record.jobId}: expected ${record.memberJobIds.length} member jobs, got ${memberJobs.length}`,
    );
  }
  const output: EncoreJobOutput[] = [];
  for (const job of memberJobs) {
    if (job.status !== 'SUCCESSFUL') {
      throw new Error(`aggregate ${record.jobId}: member job ${job.id} status=${job.status}`);
    }
    if (!Array.isArray(job.output) || job.output.length === 0) {
      throw new Error(`aggregate ${record.jobId}: member job ${job.id} has no outputs`);
    }
    output.push(...job.output);
  }
  return {
    id: record.jobId,
    externalId: record.videoId,
    status: 'SUCCESSFUL',
    outputFolder: memberJobs[0]?.outputFolder ?? '',
    inputs: [{ type: 'AudioVideo', uri: record.inputUri }],
    output,
  };
}
