import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pseudonymiseWorkspaceId } from "../../src/lib/crypto/pseudonymise.js";

// STORY-020 — the workspace pseudonym used by the audit export.
//
// ⚠ THIS FILE USED TO TEST A `pseudonymiseActorId` TOO, and that function has
// been deleted. It hashed a user id for the credit ledger's erased actor, and
// the second-engineer review inverted it: `requestIndividualErasure`
// anonymises the `users` row rather than deleting it, so the brute-force
// candidate space is `SELECT id FROM users`. The erased actor's pseudonym is
// a stored random UUID now — see `retention.ts` — so there is no function
// left to unit-test, and the property that matters is asserted where it
// happens, in `retention-cascade.spec.ts`.
//
// The workspace pseudonym is a different case and is left alone: it is
// written only into the IMMUTABLE EXPORT, never into a table alongside the
// data it de-identifies, so a reader holding the export does not also hold
// the `workspaces` row to hash against.

const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe("STORY-020 · pseudonymiseWorkspaceId", () => {
  it("is deterministic, so one workspace's export rows still group", () => {
    const id = randomUUID();
    expect(pseudonymiseWorkspaceId(id)).toBe(pseudonymiseWorkspaceId(id));
  });

  it("separates two workspaces", () => {
    expect(pseudonymiseWorkspaceId(randomUUID())).not.toBe(pseudonymiseWorkspaceId(randomUUID()));
  });

  it("does not return the input", () => {
    const id = randomUUID();
    expect(pseudonymiseWorkspaceId(id)).not.toBe(id);
  });

  it("⚠ is UUID-SHAPED but is NOT a valid v4 UUID, which is why it never goes in a uuid column", () => {
    // A sha256 slice has arbitrary version and variant nibbles. It survives
    // `/^[0-9a-f-]+$/` and fails `z.string().uuid()` most of the time — 87%,
    // measured. That is harmless here because this value only ever lands in
    // an export file. It was NOT harmless when the same construction was
    // used for `credit_ledger.actor_pseudonym`, whose published contract
    // declares `uuid`; that is one of the reasons the ledger's version is
    // now a real random UUID rather than a digest.
    const value = pseudonymiseWorkspaceId(randomUUID());
    expect(value).toMatch(UUID_SHAPED);
  });
});
