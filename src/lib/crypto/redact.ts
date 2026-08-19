// STORY-020 scenario 7 + security-and-tenancy.md §12/NFR-SEC-11: before_state
// and after_state are redacted before the audit row is written, never after
// — "the table is the boundary." Enforced by a deny-list of secret-shaped
// key names PLUS a high-entropy-string detector, so a secret stashed under
// an innocuous key is still caught. Pure, no I/O, no clock, no randomness.

export const REDACTED = "[redacted]";

const SECRET_KEY_PATTERN =
  /password|passwd|secret|token|api[_-]?key|apikey|authorization|credential|private[_-]?key|access[_-]?key|client[_-]?secret|ssn|social[_-]?security|card[_-]?number|cvv|cvc/i;

/** Shannon entropy in bits per character. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// Random tokens/secrets are both long AND high-entropy; ordinary prose or
// short identifiers are not. Both thresholds must hold to avoid flagging
// short codes ("US-BD") or long, low-entropy sentences.
const HIGH_ENTROPY_MIN_LENGTH = 20;
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 3.5;

function isHighEntropySecret(value: string): boolean {
  // Real secrets (API keys, opaque tokens) are single unbroken runs with no
  // whitespace; natural-language prose of the same length reaches a similar
  // bits-per-char average but always contains spaces, so excluding
  // whitespace-bearing strings keeps prose out without lowering the bar.
  if (/\s/.test(value)) {
    return false;
  }
  return value.length >= HIGH_ENTROPY_MIN_LENGTH && entropy(value) >= HIGH_ENTROPY_MIN_BITS_PER_CHAR;
}

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return isHighEntropySecret(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(value);
  }
  return result;
}

/**
 * Deep-redacts an audit before_state/after_state payload, returning a new
 * value — never mutates `value`. Intended to run once, immediately before
 * the audit row is written (AuditChainService.append), never on read.
 */
export function redactState(value: unknown): unknown {
  return redactValue(value);
}
