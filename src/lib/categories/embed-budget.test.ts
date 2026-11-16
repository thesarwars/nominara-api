import { describe, expect, it } from "vitest";
import {
  CATEGORY_EMBED_ALERT_NAME,
  CATEGORY_EMBED_DEFAULT_DAILY_CEILING,
  CATEGORY_EMBED_DEFAULT_MAX_INPUT_TOKENS,
  CategoryEmbedBudget,
  InMemoryTokenCounterStore,
  ValkeyTokenCounterStore,
  estimateTokens,
  type TokenCounterStore,
} from "./embed-budget.js";

// STORY-189 AC7 / owner decision 107(b): a per-project input cap (trimmed to fit) and a daily platform-wide ceiling.

const DAY = Date.UTC(2026, 10, 16, 12);

function budget(over: Partial<ConstructorParameters<typeof CategoryEmbedBudget>[0]> = {}) {
  const store = new InMemoryTokenCounterStore();
  const clock = { now: DAY };
  const b = new CategoryEmbedBudget({ store, clock: () => clock.now, ...over });
  return { b, store, clock };
}

describe("STORY-189 AC7 · defaults", () => {
  it("AC7 — the documented defaults are 2000 input tokens and 1,000,000 a day", () => {
    expect(CATEGORY_EMBED_DEFAULT_MAX_INPUT_TOKENS).toBe(2000);
    expect(CATEGORY_EMBED_DEFAULT_DAILY_CEILING).toBe(1_000_000);
  });
});

describe("STORY-189 AC7 · per-project input cap", () => {
  it("AC7 — text within the cap passes through untouched", async () => {
    const { b } = budget({ maxInputTokens: 100 });
    const r = await b.admit("short text");
    expect(r).toMatchObject({ status: "admitted", text: "short text" });
  });

  it("AC7 — text over the cap is trimmed so its estimate fits the cap, never sent whole", async () => {
    const { b } = budget({ maxInputTokens: 50 });
    const r = await b.admit("x".repeat(10_000));
    expect(r.status).toBe("admitted");
    if (r.status === "admitted") {
      expect(estimateTokens(r.text)).toBeLessThanOrEqual(50);
      expect(r.text.length).toBeGreaterThan(0);
    }
  });

  it("AC7 — boundary: text whose estimate equals the cap is not trimmed; one more character is", async () => {
    const { b } = budget({ maxInputTokens: 10 });
    const exact = "x".repeat(10 * 3);
    expect(await b.admit(exact)).toMatchObject({ text: exact });
    const over = await b.admit(exact + "y");
    expect(over.status === "admitted" && over.text.length).toBe(exact.length);
  });
});

describe("STORY-189 AC7 · daily platform-wide ceiling", () => {
  it("AC7 — below the ceiling is admitted and the reservation counts toward the day", async () => {
    const { b, store } = budget({ dailyCeiling: 1000, maxInputTokens: 2000 });
    await b.admit("x".repeat(300)); // 100 tokens
    expect(await store.addAndGet(b.dayKey(DAY), 0, 1)).toBe(100);
  });

  it("AC7 — over the ceiling is refused with a reason, and the refused reservation is given back", async () => {
    const { b, store } = budget({ dailyCeiling: 150, maxInputTokens: 2000 });
    expect((await b.admit("x".repeat(300))).status).toBe("admitted"); // 100
    const refused = await b.admit("x".repeat(300)); // would be 200 > 150
    expect(refused).toEqual({ status: "refused", reason: "daily_ceiling" });
    expect(await store.addAndGet(b.dayKey(DAY), 0, 1)).toBe(100);
  });

  it("AC7 — boundary: exactly the ceiling is admitted, one token more is refused", async () => {
    const { b } = budget({ dailyCeiling: 100, maxInputTokens: 2000 });
    expect((await b.admit("x".repeat(300))).status).toBe("admitted"); // exactly 100
    expect((await b.admit("x")).status).toBe("refused");
  });

  it("AC7 — settle records the provider's actual tokens against the day (the category vectors included)", async () => {
    const { b, store } = budget({ dailyCeiling: 100_000 });
    const r = await b.admit("x".repeat(300));
    if (r.status !== "admitted") throw new Error("expected admitted");
    await b.settle(r.reservedTokens, 7_100);
    expect(await store.addAndGet(b.dayKey(DAY), 0, 1)).toBe(7_100);
  });

  it("AC7 — settle after a midnight rollover corrects the day the reservation was made on, not the new day", async () => {
    const { b, store, clock } = budget({ dailyCeiling: 100_000 });
    const r = await b.admit("x".repeat(300)); // 100 reserved on day 1
    if (r.status !== "admitted") throw new Error("expected admitted");
    clock.now = DAY + 24 * 3_600_000; // the provider call straddled midnight
    await b.settle(r.reservedTokens, 400, r.dayKey);
    expect(await store.addAndGet(b.dayKey(DAY), 0, 1)).toBe(400);
    expect(await store.addAndGet(b.dayKey(clock.now), 0, 1)).toBe(0);
  });

  it("AC7 — a new UTC day starts from zero", async () => {
    const { b, clock } = budget({ dailyCeiling: 100 });
    expect((await b.admit("x".repeat(300))).status).toBe("admitted");
    expect((await b.admit("x")).status).toBe("refused");
    clock.now = DAY + 24 * 3_600_000;
    expect((await b.admit("x".repeat(300))).status).toBe("admitted");
  });

  it("AC7 — an unreadable counter fails closed with its own reason, and spends nothing", async () => {
    const store: TokenCounterStore = {
      addAndGet: async () => {
        throw new Error("valkey down");
      },
    };
    const { b } = budget({ store });
    expect(await b.admit("hello")).toEqual({ status: "refused", reason: "budget_unavailable" });
  });

  it("AC7 — an empty text is admitted for free: nothing is reserved", async () => {
    const { b, store } = budget();
    expect(await b.admit("")).toMatchObject({ status: "admitted", reservedTokens: 0 });
    expect(await store.addAndGet(b.dayKey(DAY), 0, 1)).toBe(0);
  });

  it("AC7 — the alert name is a stable constant", () => {
    expect(CATEGORY_EMBED_ALERT_NAME).toBe("category_embed_daily_ceiling");
  });
});

describe("STORY-189 AC7 - the Valkey counter store", () => {
  it("AC7 - increments atomically under a prefixed key and sets the expiry only when the key is created (NX)", async () => {
    const ops: unknown[][] = [];
    const tx = {
      incrby: (...a: unknown[]) => void ops.push(["incrby", ...a]),
      expire: (...a: unknown[]) => void ops.push(["expire", ...a]),
      exec: async () => [[null, 150], [null, 1]] as [Error | null, unknown][],
    };
    const store = new ValkeyTokenCounterStore({ multi: () => tx } as never, "pfx");
    expect(await store.addAndGet("k", 50, 100)).toBe(150);
    expect(ops).toEqual([["incrby", "pfx:k", 50], ["expire", "pfx:k", 100, "NX"]]);
  });

  it("AC7 - a failed increment throws, so the budget fails closed", async () => {
    const tx = { incrby: () => undefined, expire: () => undefined, exec: async () => [[new Error("x"), null]] as [Error | null, unknown][] };
    await expect(new ValkeyTokenCounterStore({ multi: () => tx } as never, "p").addAndGet("k", 1, 1)).rejects.toThrow();
  });
});
