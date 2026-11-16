import type { ClientBase } from "pg";
import { describe, expect, it } from "vitest";
import type { AliasEntry } from "../../../src/lib/parser/entity-matcher.js";
import {
  CANDIDATE_FLAG,
  CANDIDATE_THRESHOLD,
  CANDIDATE_WINDOW_DAYS,
  candidateKey,
  candidatesCrossingThreshold,
  discoveryTaskInput,
} from "../../../src/lib/parser/candidate-discovery.js";

// STORY-036 AC9 - a rolling 30-day count per untracked candidate; crossing 10 raises candidate_competitor_detected and a discovery task.

function fakeTx(rows: { key: string; label: string; seen: number }[]): { tx: ClientBase; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const tx = {
    query: (sql: string, params: unknown[] = []) => (calls.push({ sql, params }), Promise.resolve({ rows })),
  } as unknown as ClientBase;
  return { tx, calls };
}

const at = new Date("2026-11-10T12:00:00Z");
const ask = (tx: ClientBase, tracked: readonly AliasEntry[] = []) =>
  candidatesCrossingThreshold(tx, { projectId: "p1", resultId: "r1", capturedAt: at, tracked });

describe("STORY-036 AC9 - the constants come from the reference", () => {
  it("STORY-036 AC9 - 10 occurrences over a 30-day window, flag candidate_competitor_detected", () => {
    expect(CANDIDATE_THRESHOLD).toBe(10);
    expect(CANDIDATE_WINDOW_DAYS).toBe(30);
    expect(CANDIDATE_FLAG).toBe("candidate_competitor_detected");
  });
});

describe("STORY-036 AC9 - crossing the threshold", () => {
  it("STORY-036 AC9 - 9 is below, 10 crosses, 11 stays across (boundary values)", async () => {
    const rows = [
      { key: "nine co", label: "Nine Co", seen: 9 },
      { key: "ten co", label: "Ten Co", seen: 10 },
      { key: "eleven co", label: "Eleven Co", seen: 11 },
    ];
    const found = await ask(fakeTx(rows).tx);
    expect(found.map((entry) => entry.label)).toEqual(["Eleven Co", "Ten Co"]);
  });

  it("STORY-036 AC9 - an empty result is an empty list, not an error", async () => {
    expect(await ask(fakeTx([]).tx)).toEqual([]);
  });

  it("STORY-036 AC9 - a label that is NOW a tracked alias is never a candidate, however often it was seen before it was tracked", async () => {
    const tracked: AliasEntry = { entityType: "competitor", entityId: "c1", label: "Pipedrive Inc", alias: "Pipedrive  INC" };
    const found = await ask(fakeTx([{ key: "pipedrive inc", label: "Pipedrive Inc", seen: 40 }]).tx, [tracked]);
    expect(found).toEqual([]);
  });

  it("STORY-036 AC9 - the window ends at the capture's own time and is 30 days long, so a re-parse gives the same answer", async () => {
    const { tx, calls } = fakeTx([]);
    await ask(tx);
    const call = calls[0]!;
    expect(call.params).toEqual(expect.arrayContaining(["p1", "r1", at]));
    expect(call.sql).toMatch(/entity_type = 'other'/);
    expect(call.sql).toMatch(/count\(DISTINCT/i);
    expect(call.sql).toMatch(/30 days/);
  });

  it("STORY-036 AC9 - the key folds case and runs of whitespace", () => {
    expect(candidateKey("  Pipedrive   CRM ")).toBe("pipedrive crm");
  });
});

describe("STORY-036 AC9 - the discovery task", () => {
  const signal = { key: "pipedrive", label: "Pipedrive", seenCount: 14 };

  it("STORY-036 AC9 - is an automatic monitoring task that carries the count and names no raw answer text", () => {
    const input = discoveryTaskInput("p1", signal);
    expect(input).toMatchObject({ projectId: "p1", kind: "monitoring", origin: "auto", ruleCode: null });
    expect(input.title).toContain("Pipedrive");
    expect(input.description).toContain("14");
    expect(input.cooldownDays).toBe(30);
  });

  it("STORY-036 AC9 - the fingerprint is stable for a project and candidate (case-insensitive) and differs across both", () => {
    const base = discoveryTaskInput("p1", signal).fingerprint;
    expect(discoveryTaskInput("p1", { ...signal, key: candidateKey("PIPEDRIVE"), seenCount: 99 }).fingerprint.equals(base)).toBe(true);
    expect(discoveryTaskInput("p2", signal).fingerprint.equals(base)).toBe(false);
    expect(discoveryTaskInput("p1", { ...signal, key: "zoho" }).fingerprint.equals(base)).toBe(false);
  });

  it("STORY-036 AC9 - a very long label is cut so it cannot overflow a task title", () => {
    expect(discoveryTaskInput("p1", { key: "x", label: "A".repeat(500), seenCount: 10 }).title.length).toBeLessThanOrEqual(200);
  });
});
