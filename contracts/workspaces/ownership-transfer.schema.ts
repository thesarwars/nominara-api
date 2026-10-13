import { z } from "zod";

// Validates workspaces.ownership_transfer (schemas/identity-and-tenancy.md,
// EC-15 in edge-cases-and-slos.md). The column is nullable with no default —
// NULL means no transfer is in progress, so the schema itself is nullable
// rather than modelling "none" as an explicit state.
//
// Scope note: EC-15 describes a state machine plus a large pre-flight and
// execution payload (credential inventory, share-token retain/revoke
// decisions, custom-domain handoff, export requests) that no story before
// this one has implemented. This schema covers the state machine and the two
// actors precisely, per EC-15's diagram, and leaves the decision payloads as
// a permissive nested object — whichever story actually builds the transfer
// flow owns tightening that part.
const transferStateSchema = z.enum([
  "initiated",
  "awaiting_acceptance",
  "executing",
  "completed",
  "cancelled",
  "failed",
  // STORY-021 core slice: the two exits EC-15 describes as "state returns to
  // none" are RECORDED here instead of erased, so the initiating owner and the
  // recipient can both read how the last transfer ended. Neither blocks a new
  // initiation (only an unexpired `awaiting_acceptance` does).
  "declined",
  "expired",
]);

// EC-15: "the recipient declines, or acceptance expires after 7 days". One
// number, one place; the service derives `expiresAt` from it and the schema
// below carries the result.
export const OWNERSHIP_TRANSFER_TTL_DAYS = 7;

export const ownershipTransferSchema = z
  .object({
    state: transferStateSchema,
    initiatedBy: z.uuid(),
    recipientId: z.uuid(),
    initiatedAt: z.iso.datetime(),
    // Optional so a row written before this field existed still parses; the
    // service falls back to initiatedAt + OWNERSHIP_TRANSFER_TTL_DAYS.
    expiresAt: z.iso.datetime().optional(),
    // When the transfer left `awaiting_acceptance` for a terminal state.
    // Distinct from completedAt, which is only ever the successful swap.
    resolvedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    decisions: z.record(z.string(), z.unknown()).optional(),
  })
  .nullable();

export type OwnershipTransfer = z.infer<typeof ownershipTransferSchema>;
