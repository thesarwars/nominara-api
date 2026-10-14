import type { ClientBase } from "pg";
import { describe, expect, it, vi } from "vitest";
import { debitInTransaction, idempotencyKeyFor, includedGrantOf } from "./debit.js";

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
