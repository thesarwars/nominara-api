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
]);

export const ownershipTransferSchema = z
  .object({
    state: transferStateSchema,
    initiatedBy: z.uuid(),
    recipientId: z.uuid(),
    initiatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    decisions: z.record(z.string(), z.unknown()).optional(),
  })
  .nullable();

export type OwnershipTransfer = z.infer<typeof ownershipTransferSchema>;
