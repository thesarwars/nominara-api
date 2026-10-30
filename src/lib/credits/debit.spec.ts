import type { ClientBase } from "pg";
import { describe, expect, it, vi } from "vitest";
import { debitInTransaction, idempotencyKeyFor, includedGrantOf, isReservedLedgerKey } from "./debit.js";

// STORY-046 AC3 - the pure edges of the in-transaction debit. The reserve/commit
// pair against a real wallet and ledger is test/integration/prompt-activation-charge.spec.ts.

const base = {
  workspaceId: "ws",
  actorId: null,
  actorType: "system" as const,
  actionCode: "prompt_activate" as const,
  idempotencyKey: "k",
  includedGrant: 0,
};

describe("STORY-046 AC3 · debitInTransaction guards its input", () => {
  it.each([0, -1, 1.5, Number.NaN])("refuses %s credits before touching the database", async (credits) => {
    const query = vi.fn();
    await expect(debitInTransaction({ query } as unknown as ClientBase, { ...base, credits })).rejects.toThrow(/positive whole number/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("STORY-046 AC3 · idempotencyKeyFor", () => {
  it("is the same for the same set in any order", () => {
    expect(idempotencyKeyFor("p", "proj", ["b", "a", "c"])).toBe(idempotencyKeyFor("p", "proj", ["c", "a", "b"]));
  });

  it("differs by project and by set", () => {
    const k = idempotencyKeyFor("p", "proj", ["a", "b"]);
    expect(idempotencyKeyFor("p", "other", ["a", "b"])).not.toBe(k);
    expect(idempotencyKeyFor("p", "proj", ["a", "c"])).not.toBe(k);
    expect(idempotencyKeyFor("p", "proj", ["a"])).not.toBe(k);
  });

  it("does not reorder the caller's array", () => {
    const ids = ["b", "a"];
    idempotencyKeyFor("p", "proj", ids);
    expect(ids).toEqual(["b", "a"]);
  });
});

describe("STORY-046 AC3 · includedGrantOf", () => {
  const grant = (value: unknown) => includedGrantOf({ "credits.included_per_cycle": { value } });

  it("reads a positive whole number", () => expect(grant(37)).toBe(37));
  it.each([0, -5, 1.5, "custom", null, undefined])("grants nothing for %s", (value) => expect(grant(value)).toBe(0));
  it("grants nothing when the plan publishes no key", () => expect(includedGrantOf({})).toBe(0));
});

describe("STORY-078 · the server's tool-run ledger keys are reserved", () => {
  it("a client Idempotency-Key in the tool_run namespace is refused as a ledger key, in any case", () => {
    expect(isReservedLedgerKey("tool_run:0197c1e0")).toBe(true);
    expect(isReservedLedgerKey("TOOL_RUN:0197c1e0")).toBe(true);
    expect(isReservedLedgerKey("prompt_activate:x")).toBe(true);
    expect(isReservedLedgerKey("my-tool_run:x")).toBe(false);
  });
});

describe("AUXLIVE-3 · the inline debit's reference and the reserved ledger-key namespace", () => {
  it("refuses a reference with only one half named, before touching the database", async () => {
    const query = vi.fn();
    await expect(debitInTransaction({ query } as unknown as ClientBase, { ...base, credits: 10, referenceType: "aux_audit" })).rejects.toThrow(/both/);
    await expect(debitInTransaction({ query } as unknown as ClientBase, { ...base, credits: 10, referenceId: "a" })).rejects.toThrow(/both/);
    expect(query).not.toHaveBeenCalled();
  });

  it("a client Idempotency-Key starting aux_audit: (any case) is reserved: it is the namespace the manual audit's own ledger key lives in", () => {
    for (const key of ["aux_audit:abc", "AUX_AUDIT:abc", "aux_audit:"]) expect(isReservedLedgerKey(key), key).toBe(true);
    for (const key of ["my-aux_audit:x", "aux_audited", "k-1"]) expect(isReservedLedgerKey(key), key).toBe(false);
    expect(isReservedLedgerKey("prompt_activate:p:abc")).toBe(true);
  });
});
