import {
  OWNERSHIP_TRANSFER_TTL_DAYS,
  ownershipTransferSchema,
  type OwnershipTransfer,
} from "../../../contracts/workspaces/ownership-transfer.schema.js";

// STORY-021 (core slice) / EC-15 — the pure half of the ownership-transfer
// state machine: what the `workspaces.ownership_transfer` document MEANS at a
// given instant. No I/O and no clock of its own — the caller passes `now`, so
// the same rules are testable at the boundary and the service cannot disagree
// with them.
//
// Only `awaiting_acceptance` is ever live. Every other state is a recorded
// OUTCOME (completed, cancelled, declined, expired, failed): inert, and never
// a reason to refuse a fresh initiation.

export type TransferDocument = NonNullable<OwnershipTransfer>;

export const OWNERSHIP_TRANSFER_TTL_MS = OWNERSHIP_TRANSFER_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * The document, or null for "no transfer". An absent column and an
 * UNPARSABLE one are the same answer on purpose — fail closed: a malformed
 * document can never be accepted, because it never reads as pending.
 */
export function parseTransfer(raw: unknown): TransferDocument | null {
  if (raw === null || raw === undefined) return null;
  const parsed = ownershipTransferSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** When the offer lapses: the stored `expiresAt`, else initiatedAt + 7 days (rows written before the field existed). */
export function expiresAtOf(doc: TransferDocument): Date {
  if (doc.expiresAt !== undefined) return new Date(doc.expiresAt);
  return new Date(Date.parse(doc.initiatedAt) + OWNERSHIP_TRANSFER_TTL_MS);
}

/** A PENDING transfer whose deadline has been reached. The deadline itself is expired (closed on the safe side). */
export function isExpired(doc: TransferDocument | null, now: Date): boolean {
  if (doc === null || doc.state !== "awaiting_acceptance") return false;
  return now.getTime() >= expiresAtOf(doc).getTime();
}

/** Awaiting acceptance and not yet lapsed — the only state accept, decline and cancel may act on. */
export function isPending(doc: TransferDocument | null, now: Date): boolean {
  return doc !== null && doc.state === "awaiting_acceptance" && !isExpired(doc, now);
}
