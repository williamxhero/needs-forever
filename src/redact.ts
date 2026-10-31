// Remove recognizable credential formats before evidence reaches the judge or disk.
// Ordinary task authorization prose is retained, including in snapshots.
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key)$/i.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
}
