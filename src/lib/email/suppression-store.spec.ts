import { beforeEach, describe, expect, it, vi } from "vitest";

// STORY-178: the shared store builds ONE pool and attaches its error listener ONCE, however many sends reach it.
const pg = vi.hoisted(() => {
  const on = vi.fn();
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const ctor = vi.fn();
  return { on, query, ctor };
});
vi.mock("pg", () => ({
  Pool: class {
    constructor(...args: unknown[]) {
      pg.ctor(...args);
    }
    on = pg.on;
    query = pg.query;
  },
}));
vi.mock("../../config/env.js", () => ({ loadEnv: () => ({ DATABASE_URL_POOLED: "postgres://x" }) }));

import { sharedSuppressionStore } from "./suppression-store.js";

beforeEach(() => vi.clearAllMocks());

describe("STORY-178 sharedSuppressionStore", () => {
  it("attaches the pool error listener once across many sends", async () => {
    const store = sharedSuppressionStore();
    for (let i = 0; i < 25; i += 1) await store.activeKinds(Buffer.from("a"));
    expect(pg.ctor.mock.calls.length).toBeLessThanOrEqual(1);
    expect(pg.on.mock.calls.length).toBeLessThanOrEqual(1);
    expect(pg.query).toHaveBeenCalledTimes(25);
  });
});
