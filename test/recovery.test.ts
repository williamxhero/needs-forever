import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRecoveryError, nextBackoff, recordRecoveryFailure, type RecoveryFailure } from '../src/recovery.js';

test('recovery classification distinguishes timeout, invalid output, service/network, rate limit, auth and quota', () => {
  assert.equal(classifyRecoveryError(new Error('Judge timeout.')).kind, 'judge_timeout');
  assert.equal(classifyRecoveryError(new Error('Unexpected token } in JSON')).kind, 'invalid_judge_output');
  assert.equal(classifyRecoveryError(new Error('app-server exited (1)')).kind, 'service_unavailable');
  assert.equal(classifyRecoveryError(new Error('ECONNRESET while sending')).kind, 'network');
  assert.equal(classifyRecoveryError(new Error('HTTP 429 Too Many Requests')).kind, 'rate_limit');
  assert.equal(classifyRecoveryError(new Error('401 invalid token')).kind, 'authentication');
  assert.equal(classifyRecoveryError(new Error('429 insufficient quota credits')).kind, 'quota');
});

test('backoff uses 5/15/60/300 seconds and remains at 300', () => {
  const now = Date.parse('2026-11-01T00:00:00.000Z');
  assert.deepEqual(nextBackoff(1, now), { attempt: 1, delay_seconds: 5, next_at: '2026-11-01T00:00:05.000Z' });
  assert.deepEqual(nextBackoff(2, now), { attempt: 2, delay_seconds: 15, next_at: '2026-11-01T00:00:15.000Z' });
  assert.deepEqual(nextBackoff(3, now), { attempt: 3, delay_seconds: 60, next_at: '2026-11-01T00:01:00.000Z' });
  assert.deepEqual(nextBackoff(4, now), { attempt: 4, delay_seconds: 300, next_at: '2026-11-01T00:05:00.000Z' });
  assert.deepEqual(nextBackoff(99, now), { attempt: 99, delay_seconds: 300, next_at: '2026-11-01T00:05:00.000Z' });
});

test('repeated recovery failures produce an investigation instruction at threshold three', () => {
  let failures: RecoveryFailure[] = [];
  failures = recordRecoveryFailure(failures, new Error('HTTP 503 service unavailable'));
  assert.equal(failures.at(-1)?.count, 1);
  failures = recordRecoveryFailure(failures, new Error('HTTP 503 service unavailable'));
  failures = recordRecoveryFailure(failures, new Error('HTTP 503 service unavailable'));
  assert.equal(failures.at(-1)?.count, 3);
  assert.match(failures.at(-1)?.instruction ?? '', /different hypothesis|route/i);
});

