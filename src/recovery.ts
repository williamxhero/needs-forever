export type RecoveryKind =
  | 'judge_timeout'
  | 'invalid_judge_output'
  | 'service_unavailable'
  | 'network'
  | 'rate_limit'
  | 'authentication'
  | 'quota'
  | 'unknown';

export interface RecoveryClassification {
  kind: RecoveryKind;
  recoverable: boolean;
  wait_external: boolean;
  message: string;
  resume_when?: string;
}

export interface RecoveryFailure {
  signature: string;
  kind: RecoveryKind;
  count: number;
  message: string;
  instruction: string;
  at: string;
}

const DELAYS = [5, 15, 60, 300] as const;

/** A rejected model result is never a transport/provider authentication fact. */
export class JudgeOutputError extends Error {
  override readonly name = 'JudgeOutputError';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyRecoveryError(error: unknown): RecoveryClassification {
  const message = messageOf(error);
  if (error instanceof JudgeOutputError) return { kind: 'invalid_judge_output', recoverable: true, wait_external: false, message };
  const lower = message.toLowerCase();
  if (/(judge|supervisor).*(timeout|timed out)|timed out|timeout/.test(lower)) {
    return { kind: 'judge_timeout', recoverable: true, wait_external: false, message };
  }
  if (/invalid (?:judge )?(?:json|output)|unexpected token|unknown fields|missing or unknown fields|jsonl response/.test(lower)) {
    return { kind: 'invalid_judge_output', recoverable: true, wait_external: false, message };
  }
  const quota = /(quota|insufficient (?:credits|funds)|billing|credit balance|usage limit)/.test(lower);
  const authentication = /(unauthori[sz]ed|invalid token|authentication|api key|credential)/.test(lower);
  if (quota) {
    return { kind: 'quota', recoverable: false, wait_external: true, message, resume_when: 'The account quota or credits are restored, then explicitly resume the task.' };
  }
  if (authentication) {
    return { kind: 'authentication', recoverable: false, wait_external: true, message, resume_when: 'The required authentication or credential is restored, then explicitly resume the task.' };
  }
  if (/\b429\b|too many requests|rate limit|rate-limit/.test(lower)) {
    return { kind: 'rate_limit', recoverable: true, wait_external: false, message };
  }
  if (/econnreset|econnrefused|enotfound|network|socket|connection (?:closed|reset|lost)|app-server exited|service unavailable|temporarily unavailable|unable to start app-server|\b503\b|\b502\b|\b504\b/.test(lower)) {
    return { kind: /app-server|service unavailable|unable to start app-server|\b50[234]\b/.test(lower) ? 'service_unavailable' : 'network', recoverable: true, wait_external: false, message };
  }
  // Unknown failures are diagnosed and retried. They must not silently become
  // WAIT_EXTERNAL solely because the retry count increased.
  return { kind: 'unknown', recoverable: true, wait_external: false, message };
}

export function nextBackoff(attempt: number, now = Date.now(), delays: readonly number[] = DELAYS): { attempt: number; delay_seconds: number; next_at: string } {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Recovery attempt must be a positive integer.');
  const delay_seconds = delays[Math.min(attempt - 1, delays.length - 1)] ?? DELAYS.at(-1)!;
  return { attempt, delay_seconds, next_at: new Date(now + delay_seconds * 1000).toISOString() };
}

export function recoverySignature(error: unknown): string {
  const classification = classifyRecoveryError(error);
  return `${classification.kind}:${classification.message.toLowerCase().replace(/\b\d+\b/g, '#').replace(/\s+/g, ' ').trim()}`;
}

export function recordRecoveryFailure(previous: readonly RecoveryFailure[], error: unknown, now = Date.now()): RecoveryFailure[] {
  const classification = classifyRecoveryError(error);
  const signature = recoverySignature(error);
  const last = previous.at(-1);
  const count = last?.signature === signature ? last.count + 1 : 1;
  const instruction = count >= 3
    ? 'Investigate a different hypothesis, check an authorized alternative provider or local artifact, add a distinguishing check, or use a materially different route; retries alone never justify WAIT_EXTERNAL.'
    : 'Retry the same authorized operation after the scheduled backoff and record the resulting evidence.';
  return [...previous, { signature, kind: classification.kind, count, message: classification.message, instruction, at: new Date(now).toISOString() }];
}
