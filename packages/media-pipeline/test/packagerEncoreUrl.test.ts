import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLoopbackEncoreUrl, rewriteEncoreJobUrlForPackager } from '../packagerEncoreUrl.js';

describe('packagerEncoreUrl', () => {
  it('detects loopback Encore URLs', () => {
    assert.equal(isLoopbackEncoreUrl('http://127.0.0.1:8080/encoreJobs/1'), true);
    assert.equal(isLoopbackEncoreUrl('http://localhost:8080/encoreJobs/1'), true);
    assert.equal(isLoopbackEncoreUrl('http://[::1]:8080/encoreJobs/1'), true);
    assert.equal(isLoopbackEncoreUrl('http://encore-web:8080/encoreJobs/1'), false);
  });

  it('rewrites loopback to encore-web when PACKAGER_ENCORE_BASE_URL unset', () => {
    const out = rewriteEncoreJobUrlForPackager('http://127.0.0.1:8080/encoreJobs/abc', {});
    assert.equal(out, 'http://encore-web:8080/encoreJobs/abc');
  });

  it('rewrites IPv6 loopback [::1] to encore-web', () => {
    const out = rewriteEncoreJobUrlForPackager('http://[::1]:8080/encoreJobs/abc', {});
    assert.equal(out, 'http://encore-web:8080/encoreJobs/abc');
  });

  it('honors PACKAGER_ENCORE_BASE_URL', () => {
    const out = rewriteEncoreJobUrlForPackager('http://127.0.0.1:8080/encoreJobs/abc', {
      PACKAGER_ENCORE_BASE_URL: 'http://host.docker.internal:8080',
    });
    assert.equal(out, 'http://host.docker.internal:8080/encoreJobs/abc');
  });

  it('clears the original port when the target base has none', () => {
    const out = rewriteEncoreJobUrlForPackager('http://127.0.0.1:8080/encoreJobs/abc', {
      PACKAGER_ENCORE_BASE_URL: 'http://encore-web',
    });
    assert.equal(out, 'http://encore-web/encoreJobs/abc');
  });

  it('keeps an explicit destination port', () => {
    const out = rewriteEncoreJobUrlForPackager('http://127.0.0.1:8080/encoreJobs/abc', {
      PACKAGER_ENCORE_BASE_URL: 'http://encore-web:9090',
    });
    assert.equal(out, 'http://encore-web:9090/encoreJobs/abc');
  });

  it('throws controlled error for malformed PACKAGER_ENCORE_BASE_URL', () => {
    assert.throws(
      () =>
        rewriteEncoreJobUrlForPackager('http://127.0.0.1:8080/encoreJobs/abc', {
          PACKAGER_ENCORE_BASE_URL: 'http://[bad',
        }),
      /Invalid PACKAGER_ENCORE_BASE_URL/,
    );
  });

  it('does not echo PACKAGER_ENCORE_BASE_URL value in parse errors', () => {
    const secret = 'http://user:super-secret@host:8080';
    assert.throws(
      () =>
        rewriteEncoreJobUrlForPackager('http://127.0.0.1:8080/encoreJobs/abc', {
          PACKAGER_ENCORE_BASE_URL: `${secret}[bad`,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'Invalid PACKAGER_ENCORE_BASE_URL');
        assert.doesNotMatch(err.message, /super-secret/);
        return true;
      },
    );
  });

  it('leaves docker-DNS URLs unchanged without override', () => {
    const url = 'http://encore-web:8080/encoreJobs/abc';
    assert.equal(rewriteEncoreJobUrlForPackager(url, {}), url);
  });

  it('routes aggregate job URLs to the supervisor base', () => {
    const out = rewriteEncoreJobUrlForPackager(
      'http://vmp-supervisor:8788/vmp/api/encoreJobAggregate/agg-v1',
      { PACKAGER_SUPERVISOR_BASE_URL: 'http://media.lan:8788' },
    );
    assert.equal(out, 'http://media.lan:8788/vmp/api/encoreJobAggregate/agg-v1');
  });

  it('aggregate rewrite wins over PACKAGER_ENCORE_BASE_URL', () => {
    const out = rewriteEncoreJobUrlForPackager(
      'http://127.0.0.1:8788/vmp/api/encoreJobAggregate/agg-v1',
      { PACKAGER_ENCORE_BASE_URL: 'http://encore-web:8080' },
    );
    assert.equal(out, 'http://vmp-supervisor:8788/vmp/api/encoreJobAggregate/agg-v1');
  });
});
