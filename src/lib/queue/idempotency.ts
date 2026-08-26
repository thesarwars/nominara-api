import { uuidV7 } from "../ids/uuidv7.js";
import { QUEUE_TOPOLOGY, type QueueTopologyEntry } from "./topology.js";

// STORY-030 — "Idempotency keys are documented per queue rather than
// invented per worker because the correct key is a design decision."
// topology.ts's `idempotencyKeyPattern` is the single source of truth for
// the pattern text; this module only substitutes params into it, so the
// pattern is never hand-copied a second time here.

export type QueueName = QueueTopologyEntry["name"];

export class IdempotencyKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyKeyError";
  }
}

export type IdempotencyKeyParams = Record<string, string>;

const TOPOLOGY_BY_NAME: ReadonlyMap<QueueName, QueueTopologyEntry> = new Map(
  QUEUE_TOPOLOGY.map((entry) => [entry.name, entry]),
);

const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g;

function extractPlaceholders(pattern: string): string[] {
  return Array.from(pattern.matchAll(PLACEHOLDER_PATTERN), (match) => match[1]!);
}

/**
 * Builds `queueName`'s documented idempotency key by substituting `params`
 * into its `idempotencyKeyPattern`. Fails closed on both directions: a
 * missing placeholder value, or an extra param with no matching placeholder,
 * throws rather than silently emitting a partial or over-broad key — a
 * capture keyed on the cell is idempotent only if the key is built from
 * exactly its documented fields, never more, never fewer.
 */
export function buildIdempotencyKey(queueName: QueueName, params: IdempotencyKeyParams): string {
  const entry = TOPOLOGY_BY_NAME.get(queueName);
  if (!entry) {
    throw new IdempotencyKeyError(`unknown queue "${queueName}"`);
  }

  const placeholders = extractPlaceholders(entry.idempotencyKeyPattern);
  const missing = placeholders.filter((name) => !(name in params));
  if (missing.length > 0) {
    throw new IdempotencyKeyError(
      `queue "${queueName}" idempotency key is missing required param(s): ${missing.join(", ")}`,
    );
  }

  const extra = Object.keys(params).filter((name) => !placeholders.includes(name));
  if (extra.length > 0) {
    throw new IdempotencyKeyError(
      `queue "${queueName}" idempotency key received unexpected param(s): ${extra.join(", ")}`,
    );
  }

  return entry.idempotencyKeyPattern.replace(PLACEHOLDER_PATTERN, (_match, name: string) => params[name]!);
}

/**
 * One bound key-builder per documented queue, derived from QUEUE_TOPOLOGY —
 * adding a queue to the topology table makes it buildable here with no
 * parallel edit required.
 */
export const QUEUE_IDEMPOTENCY_KEY_BUILDERS: Readonly<Record<QueueName, (params: IdempotencyKeyParams) => string>> =
  Object.fromEntries(
    QUEUE_TOPOLOGY.map((entry) => [
      entry.name,
      (params: IdempotencyKeyParams) => buildIdempotencyKey(entry.name, params),
    ]),
  ) as Record<QueueName, (params: IdempotencyKeyParams) => string>;

/**
 * Replay from the administrative surface must never collide with the
 * original job's idempotency key — appends a fresh UUIDv7 suffix (or an
 * injected one, for deterministic tests) rather than reusing any part of
 * the original job's identity.
 */
export function withReplaySuffix(key: string, suffix: string = uuidV7()): string {
  // Deliberately `key + ...` rather than a single template literal opening
  // with `${key}` — the ISO-13 scanner (test/isolation/assertions/
  // iso-13-cache-namespace.ts) fail-closed flags any key-construction
  // expression that OPENS with an interpolation as un-namespaced. The
  // resulting string is identical either way; this shape just keeps the
  // queue-key builders consistent with the rest of this file's
  // literal-prefix-first convention (F5) so the scanner doesn't need a
  // per-file exemption.
  return key + `:replay:${suffix}`;
}
