import type { ClientBase } from "pg";
import { describe, expect, it } from "vitest";
import { resolveTopicFilter } from "./topic-filter.js";

const A = "0199aaaa-0000-7000-8000-000000000001";
const B = "0199aaaa-0000-7000-8000-000000000002";
const txKnowing = (known: string[]): { tx: ClientBase; calls: unknown[][] } => {
  const calls: unknown[][] = [];
  const tx = {
    query: async (_sql: string, params: unknown[]) => {
      calls.push(params);
      return { rows: (params[1] as string[]).filter((id) => known.includes(id)).map((id) => ({ id })) };
    },
  } as unknown as ClientBase;
  return { tx, calls };
};

describe("STORY-090 AC8 · resolveTopicFilter", () => {
  it("is null without a query - and reads nothing", async () => {
    const { tx, calls } = txKnowing([]);
    expect(await resolveTopicFilter(tx, "p", undefined)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns the de-duplicated ids when the project has them all", async () => {
    const { tx } = txKnowing([A, B]);
    expect(await resolveTopicFilter(tx, "p", `${A},${B},${A}`)).toEqual([A, B]);
  });

  it("refuses an id the project lacks with a 400 naming `topics` and the id, even when others are known", async () => {
    const { tx } = txKnowing([A]);
    await expect(resolveTopicFilter(tx, "p", `${A},${B}`)).rejects.toMatchObject({
      code: "validation_failed",
      details: { issues: [{ path: ["topics"], message: expect.stringContaining(B) }] },
    });
  });
});
