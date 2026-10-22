import { describe, expect, it } from "vitest";
import {
  PolitenessBudget,
  PolitenessCapReached,
  PolitenessDeadlineReached,
  MIN_INTERVAL_MS,
  MAX_REQUESTS_PER_SECOND,
  MAX_HONOURED_CRAWL_DELAY_MS,
} from "./politeness.js";

// STORY-049 AC7 / scenario 8 — the crawl's politeness budget: <= 2 requests per second per host, a 500 ms
// minimum interval, the declared Crawl-delay honoured, and a hard stop. ONE budget is shared by every kind of request to
// the host (site files and pages).

function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

const budget = (clock: ReturnType<typeof fakeClock>, over: Partial<ConstructorParameters<typeof PolitenessBudget>[0]> = {}) =>
  new PolitenessBudget({ hardCap: 100, now: clock.now, sleep: clock.sleep, ...over });

describe("STORY-049 AC7 · politeness budget", () => {
  it("the documented numbers: 2 requests per second, a 500 ms minimum interval", () => {
    expect(MIN_INTERVAL_MS).toBe(500);
    expect(MAX_REQUESTS_PER_SECOND).toBe(2);
  });

  it("scenario 8 — the first request goes at once; the next waits out the minimum interval", async () => {
    const clock = fakeClock();
    const b = budget(clock);
    await b.acquire("page");
    expect(clock.sleeps).toEqual([]);
    await b.acquire("page");
    expect(clock.sleeps).toEqual([500]);
  });

  it("scenario 8 — time already spent between requests counts toward the interval", async () => {
    const clock = fakeClock();
    const b = budget(clock);
    await b.acquire("page");
    clock.advance(300);
    await b.acquire("page");
    expect(clock.sleeps).toEqual([200]);
    clock.advance(900);
    await b.acquire("page");
    expect(clock.sleeps).toEqual([200]); // 900 > 500: no wait
  });

  it("never exceeds 2 requests in any 1 second window, over a long run", async () => {
    const clock = fakeClock();
    const b = budget(clock);
    const starts: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      await b.acquire("page");
      starts.push(clock.now());
    }
    for (let i = 2; i < starts.length; i += 1) expect(starts[i]! - starts[i - 2]!).toBeGreaterThanOrEqual(1000);
  });

  it("scenario 8 — a declared Crawl-delay longer than the floor is honoured exactly", async () => {
    const clock = fakeClock();
    const b = budget(clock, { crawlDelaySeconds: 3 });
    await b.acquire("page");
    await b.acquire("page");
    expect(clock.sleeps).toEqual([3000]);
  });

  it("scenario 8 — a Crawl-delay SHORTER than the floor never lowers it; 0 and null both mean the floor", async () => {
    for (const delay of [0.1, 0, null]) {
      const clock = fakeClock();
      const b = budget(clock, { crawlDelaySeconds: delay });
      await b.acquire("page");
      await b.acquire("page");
      expect(clock.sleeps).toEqual([500]);
    }
  });

  it("a Crawl-delay learned mid-crawl (robots.txt is fetched first) applies from the next request", async () => {
    const clock = fakeClock();
    const b = budget(clock);
    await b.acquire("site_file"); // robots.txt itself
    b.setCrawlDelay(4);
    await b.acquire("site_file");
    expect(clock.sleeps).toEqual([4000]);
  });

  it("an unusable Crawl-delay (negative, NaN, Infinity) cannot disable the floor", async () => {
    for (const delay of [-5, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const clock = fakeClock();
      const b = budget(clock, { crawlDelaySeconds: delay });
      await b.acquire("page");
      await b.acquire("page");
      expect(clock.sleeps).toEqual([500]);
    }
  });

  it("concurrent callers are serialised, not released together", async () => {
    const clock = fakeClock();
    const b = budget(clock);
    const grantedAt: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async () => {
        await b.acquire("page");
        grantedAt.push(clock.now());
      }),
    );
    expect(grantedAt[1]! - grantedAt[0]!).toBeGreaterThanOrEqual(500);
    expect(grantedAt[2]! - grantedAt[1]!).toBeGreaterThanOrEqual(500);
  });
});

// The differential probe's two-request tests lived here; the probe was removed on 2026-10-22 (no request is sent under
// another crawler's name), so what they proved (every kind of request draws on ONE budget and waits out the interval) is
// asserted for the kinds that remain.
describe("STORY-049 AC7 — site files and pages are charged to the same budget", () => {
  it("site files and pages are counted together and apart", async () => {
    const clock = fakeClock();
    const b = budget(clock);
    await b.acquire("site_file");
    await b.acquire("page");
    await b.acquire("page");
    expect(b.used).toBe(3);
    expect(b.usedBy("page")).toBe(2);
    expect(b.usedBy("site_file")).toBe(1);
  });

  it("a page request waits out the interval after a site file like any other request", async () => {
    const clock = fakeClock();
    const b = budget(clock);
    await b.acquire("site_file");
    await b.acquire("page");
    expect(clock.sleeps).toEqual([500]);
  });
});

describe("STORY-049 AC7 · hard stop", () => {
  it("refuses the request past the hard cap WITHOUT waiting, and says so with a typed error", async () => {
    const clock = fakeClock();
    const b = budget(clock, { hardCap: 3 });
    for (let i = 0; i < 3; i += 1) await b.acquire("page");
    const sleepsBefore = clock.sleeps.length;
    await expect(b.acquire("page")).rejects.toBeInstanceOf(PolitenessCapReached);
    expect(clock.sleeps.length).toBe(sleepsBefore);
    expect(b.used).toBe(3); // a refused request is not counted as made
  });

  it("a cap of 0 refuses everything; remaining reports what is left", async () => {
    const clock = fakeClock();
    const none = budget(clock, { hardCap: 0 });
    await expect(none.acquire("page")).rejects.toBeInstanceOf(PolitenessCapReached);
    const b = budget(clock, { hardCap: 2 });
    expect(b.remaining).toBe(2);
    await b.acquire("page");
    expect(b.remaining).toBe(1);
  });

  it("rejects a cap that is not a non-negative integer (a NaN cap would silently disable the stop)", () => {
    const clock = fakeClock();
    for (const hardCap of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => budget(clock, { hardCap })).toThrow(/hard cap/i);
    }
  });
});

// REVIEW FINDING — the target's robots.txt is untrusted input and is read even for an UNVERIFIED project. aux-and-geo-analysis.md
// §1 says the crawl "honours Crawl-delay". A delay up to MAX_HONOURED_CRAWL_DELAY_MS is honoured EXACTLY (rounded UP to a whole
// millisecond so the crawl is never faster than asked and every duration stays an integer). A longer one is honoured as the cap
// and the declared value is reported (OWNER DECISION 2026-10-22, NOT FROM THE REFERENCE): honoured exactly, a 86400 s delay cost
// the audit llms.txt and the sitemap, because three waits of that length cannot fit any wall-clock budget. `acquire` still refuses
// (never sleeps) when a wait would pass the deadline, and `affordableRequests` shrinks the page list up front.
describe("politeness · a declared Crawl-delay is honoured up to a cap, and a hostile one still cannot pin a worker", () => {
  it("the cap is 60 s", () => {
    expect(MAX_HONOURED_CRAWL_DELAY_MS).toBe(60_000);
  });

  it.each([[10, 10_000], [11, 11_000], [60, 60_000], [10.0001, 10_001], [0.5001, 501]])("a declared Crawl-delay of %s s at or under the cap is the interval, rounded up to a whole ms (%s)", (seconds, ms) => {
    const clock = fakeClock();
    const a = budget(clock, { crawlDelaySeconds: seconds });
    expect(a.intervalMs).toBe(ms);
    expect(Number.isInteger(a.intervalMs)).toBe(true);
    expect(a.declaredCrawlDelayMs).toBeNull(); // nothing was shortened
    const b = budget(clock);
    b.setCrawlDelay(seconds);
    expect(b.intervalMs).toBe(ms);
  });

  it.each([60.001, 61, 86_400, 1e9])("a declared Crawl-delay of %s s above the cap is honoured as the cap, and the declared value is reported", (seconds) => {
    const clock = fakeClock();
    const b = budget(clock, { crawlDelaySeconds: seconds });
    expect(b.intervalMs).toBe(MAX_HONOURED_CRAWL_DELAY_MS);
    expect(b.declaredCrawlDelayMs).toBe(Math.ceil(seconds * 1000));
    const c = budget(clock);
    c.setCrawlDelay(seconds);
    expect(c.intervalMs).toBe(MAX_HONOURED_CRAWL_DELAY_MS);
    expect(c.declaredCrawlDelayMs).toBe(Math.ceil(seconds * 1000));
  });

  it("a later, shorter declaration replaces a capped one: the declared value is no longer reported", () => {
    const clock = fakeClock();
    const b = budget(clock, { crawlDelaySeconds: 86_400 });
    b.setCrawlDelay(5);
    expect(b.intervalMs).toBe(5_000);
    expect(b.declaredCrawlDelayMs).toBeNull();
  });

  it("with no deadline, a 60 s delay (the cap itself) is slept in full, never shortened", async () => {
    const clock = fakeClock();
    const b = budget(clock, { crawlDelaySeconds: 60 });
    await b.acquire("site_file");
    await b.acquire("site_file");
    expect(clock.sleeps).toEqual([60_000]);
  });

  it.each([Number.NaN, -5, Number.POSITIVE_INFINITY, 0, 0.1])("an unusable or sub-floor declared delay (%s) leaves the 500 ms floor", (seconds) => {
    const clock = fakeClock();
    expect(budget(clock, { crawlDelaySeconds: seconds }).intervalMs).toBe(MIN_INTERVAL_MS);
  });

  it.each([86_400, 1e9])("Crawl-delay %s under a REAL wall-clock budget (10 min): the site files fit, each after a full 60 s wait, then the deadline refuses without sleeping", async (seconds) => {
    const clock = fakeClock();
    const start = clock.now();
    const b = budget(clock, { hardCap: 1_000, crawlDelaySeconds: seconds, wallClockBudgetMs: 600_000 });
    let granted = 0;
    let stopped: unknown;
    for (let i = 0; i < 1_000; i += 1) {
      try {
        await b.acquire("site_file");
        granted += 1;
      } catch (error) {
        stopped = error;
        break;
      }
    }
    expect(stopped).toBeInstanceOf(PolitenessDeadlineReached);
    expect(granted).toBe(11); // t = 0, 60, ..., 600 s: robots, llms, well-known llms and the sitemap all fit with room to spare
    expect(clock.sleeps).toEqual(Array.from({ length: 10 }, () => 60_000));
    expect(clock.now() - start).toBe(600_000);
  });

  it("a wait longer than the time left is refused BEFORE sleeping, never shortened", async () => {
    const clock = fakeClock();
    const start = clock.now();
    const b = budget(clock, { hardCap: 1_000, crawlDelaySeconds: 86_400, wallClockBudgetMs: 59_999 });
    await b.acquire("site_file"); // robots.txt: the first request, no wait
    await expect(b.acquire("page")).rejects.toBeInstanceOf(PolitenessDeadlineReached);
    expect(clock.sleeps).toEqual([]);
    expect(clock.now() - start).toBe(0);
    expect(b.used).toBe(1);
    expect(b.affordableRequests()).toBe(0);
  });

  it("a delay that fits the deadline is slept in full, and the deadline refuses the request after it", async () => {
    const clock = fakeClock();
    const b = budget(clock, { hardCap: 1_000, crawlDelaySeconds: 20, wallClockBudgetMs: 60_000 });
    let granted = 0;
    let stopped: unknown;
    for (let i = 0; i < 1_000; i += 1) {
      try {
        await b.acquire("page");
        granted += 1;
      } catch (error) {
        stopped = error;
        break;
      }
    }
    expect(stopped).toBeInstanceOf(PolitenessDeadlineReached);
    expect(granted).toBe(4); // t = 0, 20, 40, 60 s
    expect(clock.sleeps).toEqual([20_000, 20_000, 20_000]);
    expect(b.used).toBe(4); // the refused request is not counted as made
  });

  it("the deadline is a distinct condition from the request cap, and is checked even for the first request", async () => {
    const clock = fakeClock();
    const b = budget(clock, { wallClockBudgetMs: 1_000 });
    clock.advance(1_001); // the budget was spent before the first request was ever made
    await expect(b.acquire("site_file")).rejects.toBeInstanceOf(PolitenessDeadlineReached);
    expect(new PolitenessDeadlineReached(1)).not.toBeInstanceOf(PolitenessCapReached);
  });

  it("affordableRequests says how many more requests fit before the deadline at the current interval", () => {
    const clock = fakeClock();
    const b = budget(clock, { wallClockBudgetMs: 60_000, crawlDelaySeconds: 10 });
    expect(b.affordableRequests()).toBe(7);
    clock.advance(30_000);
    expect(b.affordableRequests()).toBe(4);
    clock.advance(1e9);
    expect(b.affordableRequests()).toBe(0);
    expect(budget(clock).affordableRequests()).toBe(Number.POSITIVE_INFINITY);
  });
});
