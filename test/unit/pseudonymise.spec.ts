import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pseudonymiseActorId, pseudonymiseWorkspaceId } from "../../src/lib/crypto/pseudonymise.js";

// STORY-073 AC13 — the properties the credit ledger's erased actor depends
// on. Two are checked by the retention integration suite (an erased person's
// rows still group; two erased people stay apart); these are the ones a
// behavioural test cannot reach.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe("STORY-073 · pseudonymiseActorId", () => {
  it("is deterministic, which is what lets one person's charges group", () => {
    const id = randomUUID();
    expect(pseudonymiseActorId(id)).toBe(pseudonymiseActorId(id));
  });

  it("separates two people", () => {
    expect(pseudonymiseActorId(randomUUID())).not.toBe(pseudonymiseActorId(randomUUID()));
  });

  it("is UUID-shaped, because the column it lands in is a uuid", () => {
    expect(pseudonymiseActorId(randomUUID())).toMatch(UUID);
  });

  it("does not return the input", () => {
    const id = randomUUID();
    expect(pseudonymiseActorId(id)).not.toBe(id);
  });

  it("⚠ does NOT collide with the workspace pseudonym for the same input", () => {
    // ⚠ THE PROPERTY NO BEHAVIOURAL TEST REACHES, and the reason the two
    // functions carry different domain prefixes rather than sharing one
    // helper. A workspace id and a user id are both UUIDs from the same
    // space, so they CAN be equal — and a shared prefix would make an
    // erased person's ledger pseudonym equal to some workspace's export
    // pseudonym, grouping two unrelated things together in a record kept
    // for disputes.
    //
    // Nothing observable breaks until the day those two UUIDs coincide,
    // which is exactly the kind of defect that ships.
    const id = randomUUID();
    expect(pseudonymiseActorId(id)).not.toBe(pseudonymiseWorkspaceId(id));
  });
});
