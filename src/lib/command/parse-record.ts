import { z } from "zod";
import { COMMAND_INTENTS } from "../../../contracts/command/command-intent.schema.js";
import { lowercaseUuidSchema } from "../../../contracts/common/uuid.schema.js";
import type { Cache } from "../cache/cache.port.js";
import { tenantKey } from "../cache/valkey-keys.js";

// STORY-085 (decision 79) - the single-use parse identifier.
//
// A parse that resolved to an action stores ONE record under its parse id; execute consumes it. The record is
// what the parse bound AT THE CALLER'S OWN scope (the project id, the price it quoted), so execute never
// re-derives it from text and never trusts a client-supplied id over it.
//
// WHY HERE AND NOT IN src/modules/command: the credit guard reads it (it must know the action and the project
// BEFORE it reserves anything) and so does the command module. A lib file both import is the dependency
// direction the rest of the guard chain already follows; it is not a new layer.
//
// BOUND THREE WAYS. The key carries the workspace (Valkey has no RLS - valkey-keys.ts), and the record carries
// the user and the action id, all re-checked on read. A parse id presented by another user of the same
// workspace is refused and, deliberately, NOT consumed: refusing must not let a colleague burn your id.
//
// ATOMIC CONSUME is `deleteIf(key, exactValueRead)`: the delete reports true to exactly one of any number of
// concurrent callers, so a parse id executes at most once. There is no read-then-delete window to race.

/** Short-lived: long enough to read a confirmation, short enough that an old id is not a standing licence. */
export const PARSE_RECORD_TTL_MS = 10 * 60 * 1000;

/** The credit-priced actions the bar can execute. A narrow literal here; the guard maps it to the plan's price key. */
export const commandCreditActionSchema = z.literal("deep_scan");

export const parseRecordSchema = z
  .object({
    workspace_id: lowercaseUuidSchema,
    /** The tenant context's actor: the user (or the key's actor) the parse was issued to. */
    actor_id: z.string().min(1),
    action_id: z.string().min(1),
    intent: z.enum(COMMAND_INTENTS),
    handling: z.enum(["execute", "open_screen", "client"]),
    /** The permission the underlying endpoint requires, or null for an action that needs none. */
    required_permission: z.string().min(1).nullable(),
    credit_action: commandCreditActionSchema.nullable(),
    /** Bound from the typed text within the caller's scope; null when the text named none. */
    project_id: lowercaseUuidSchema.nullable(),
    project_name: z.string().min(1).nullable(),
    /** The typed slots, kept so an `open_screen` outcome can prefill without a second parse. */
    slots: z.record(z.string(), z.string()),
  })
  .strict();

export type ParseRecord = z.infer<typeof parseRecordSchema>;

export function parseRecordKey(env: string, workspaceId: string, parseId: string): string {
  return tenantKey(env, workspaceId, "command-parse-id", parseId);
}

export async function storeParseRecord(cache: Cache, env: string, parseId: string, record: ParseRecord): Promise<void> {
  const stored = await cache.set(parseRecordKey(env, record.workspace_id, parseId), JSON.stringify(record), {
    ttlMs: PARSE_RECORD_TTL_MS,
    onlyIfAbsent: true,
  });
  if (!stored) throw new Error("a parse id collided with a standing record");
}

/** Why a parse id was refused. Both reach the caller as the same 409: an expired id and a used id are indistinguishable by design. */
export type ParseRecordRefusal = "unknown_or_used" | "not_yours" | "wrong_action";

export type ParseRecordRead =
  | { readonly ok: true; readonly record: ParseRecord; readonly raw: string; readonly key: string }
  | { readonly ok: false; readonly reason: ParseRecordRefusal };

export interface ParseRecordBinding {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly actionId: string;
}

/** Reads and checks the binding WITHOUT consuming. The credit guard uses this: a price_changed refusal must leave the id usable. */
export async function peekParseRecord(
  cache: Cache,
  env: string,
  parseId: string,
  binding: ParseRecordBinding,
): Promise<ParseRecordRead> {
  const key = parseRecordKey(env, binding.workspaceId, parseId);
  const raw = await cache.get(key);
  if (raw === undefined) return { ok: false, reason: "unknown_or_used" };
  let record: ParseRecord;
  try {
    record = parseRecordSchema.parse(JSON.parse(raw));
  } catch {
    // An unreadable record is never executed: fail closed.
    return { ok: false, reason: "unknown_or_used" };
  }
  if (record.workspace_id !== binding.workspaceId || record.actor_id !== binding.actorId) {
    return { ok: false, reason: "not_yours" };
  }
  if (record.action_id !== binding.actionId) return { ok: false, reason: "wrong_action" };
  return { ok: true, record, raw, key };
}

/** Consumes a record already read by `peekParseRecord`. True for exactly one caller. */
export function consumeParseRecord(cache: Cache, read: Extract<ParseRecordRead, { ok: true }>): Promise<boolean> {
  return cache.deleteIf(read.key, read.raw);
}
