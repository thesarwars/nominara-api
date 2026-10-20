// STORY-049 AC7 / AC8 — the crawl's politeness budget for ONE host.
//
// aux-and-geo-analysis.md §1: "<= 2 requests per second per host with a 500 ms minimum interval, honours `Crawl-delay`,
// ... and hard-stops at the page cap". Nominara crawls only domains the customer verified, and a crawler that hammers a
// customer's site is a worse outcome than a crawler that is slow.
//
// ONE BUDGET FOR EVERY KIND OF REQUEST. The site files, the pages (both fetches) and BOTH halves of the differential probe
// draw from the same budget (the story's AC8: "both count against the politeness budget"). The probe doubles request
// volume on the pages it runs against; exempting it would breach politeness on exactly the sites most likely to be
// sensitive about crawling.
//
// 2 req/s and a 500 ms interval are the same constraint stated twice (an interval of 500 ms is at most 2 starts in any
// 1000 ms window), so ONE interval enforces both; a unit test checks the window directly rather than trusting the algebra.

/** aux-and-geo-analysis.md §1: a 500 ms minimum interval between requests to one host. */
export const MIN_INTERVAL_MS = 500;
/** aux-and-geo-analysis.md §1: at most 2 requests per second per host. */
export const MAX_REQUESTS_PER_SECOND = 2;

/**
 * NOT FROM THE REFERENCE. The reference says the crawl "honours Crawl-delay" and names no upper bound; robots.txt is
 * untrusted input, read even for an unverified project, and an unbounded delay kept one crawl.audit job asleep for days
 * inside an open tenant transaction. The honoured delay is clamped here; a longer declared value is treated as this.
 * 10 s is already 20x the 500 ms floor. Provisional until the architect names a number.
 */
export const MAX_CRAWL_DELAY_SECONDS = 10;

export type RequestKind = "site_file" | "page" | "probe";

/** The hard cap is spent. A typed error, never a silent skip: the caller records what it did not fetch. */
export class PolitenessCapReached extends Error {
  constructor(readonly cap: number) {
    super(`politeness: the hard cap of ${String(cap)} requests to this host is spent`);
    this.name = "PolitenessCapReached";
  }
}

/**
 * The wall-clock budget for the whole crawl is spent. Distinct from `PolitenessCapReached` (the request count): the
 * caller records what it did not fetch as `crawl_delay_budget`, not as the page cap.
 */
export class PolitenessDeadlineReached extends Error {
  constructor(readonly budgetMs: number) {
    super(`politeness: the ${String(budgetMs)} ms wall-clock budget for this crawl is spent`);
    this.name = "PolitenessDeadlineReached";
  }
}

export interface PolitenessOptions {
  /** The most requests of ALL kinds this crawl may make to the host. */
  readonly hardCap: number;
  /** The target's declared `Crawl-delay` in seconds, when robots.txt is already known. null/0 = none declared. */
  readonly crawlDelaySeconds?: number | null;
  /**
   * NOT FROM THE REFERENCE. The most wall-clock milliseconds, from construction, the crawl may take. A request that
   * would START after it is refused with `PolitenessDeadlineReached` instead of slept for. Absent = unbounded (tests only).
   */
  readonly wallClockBudgetMs?: number;
  /** Milliseconds; injectable so the spec runs on a fake clock. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class PolitenessBudget {
  private readonly hardCap: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private crawlDelayMs = 0;
  private readonly deadline: number | null;
  private readonly wallClockBudgetMs: number;
  private lastStart: number | null = null;
  private count = 0;
  private readonly byKind: Record<RequestKind, number> = { site_file: 0, page: 0, probe: 0 };
  /** Callers are serialised on this chain, so two concurrent acquire() calls can never be released at the same instant. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: PolitenessOptions) {
    // A NaN cap would make every `used >= cap` comparison false and silently disable the stop.
    if (!Number.isInteger(options.hardCap) || options.hardCap < 0) {
      throw new Error(`politeness: the hard cap must be a non-negative integer, received ${String(options.hardCap)}`);
    }
    this.hardCap = options.hardCap;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.wallClockBudgetMs = options.wallClockBudgetMs ?? Number.POSITIVE_INFINITY;
    this.deadline = options.wallClockBudgetMs === undefined ? null : this.now() + options.wallClockBudgetMs;
    this.setCrawlDelay(options.crawlDelaySeconds ?? null);
  }

  /**
   * robots.txt is the FIRST request, so its `Crawl-delay` is only known after it: call this once it is parsed. An unusable
   * value (negative, NaN, Infinity) is ignored; no declared delay can LOWER the 500 ms floor, and none can RAISE the
   * interval above MAX_CRAWL_DELAY_SECONDS.
   */
  setCrawlDelay(seconds: number | null): void {
    this.crawlDelayMs = seconds !== null && Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, MAX_CRAWL_DELAY_SECONDS) * 1000 : 0;
  }

  get used(): number {
    return this.count;
  }

  get remaining(): number {
    return this.hardCap - this.count;
  }

  usedBy(kind: RequestKind): number {
    return this.byKind[kind];
  }

  /** The gap enforced between two request starts right now: the declared delay when it is longer than the floor. */
  get intervalMs(): number {
    return Math.max(MIN_INTERVAL_MS, this.crawlDelayMs);
  }

  /**
   * How many more requests can START before the deadline at the current interval; infinity with no deadline. An estimate
   * (it ignores how long each response takes), used to shrink the page list up front; `acquire` is the backstop.
   */
  affordableRequests(): number {
    if (this.deadline === null) return Number.POSITIVE_INFINITY;
    const earliest = this.lastStart === null ? this.now() : Math.max(this.now(), this.lastStart + this.intervalMs);
    if (earliest > this.deadline) return 0;
    return 1 + Math.floor((this.deadline - earliest) / this.intervalMs);
  }

  /**
   * Resolves when the caller may send ONE request, having waited out the interval since the previous start. Throws
   * `PolitenessCapReached` without waiting once the cap is spent, and `PolitenessDeadlineReached` without waiting when
   * the wait would carry the request past the wall-clock deadline; a refused request is not counted as made.
   */
  acquire(kind: RequestKind): Promise<void> {
    const turn = this.tail.then(async () => {
      if (this.count >= this.hardCap) throw new PolitenessCapReached(this.hardCap);
      const wait = this.lastStart === null ? 0 : this.lastStart + this.intervalMs - this.now();
      if (this.deadline !== null && this.now() + Math.max(wait, 0) > this.deadline) throw new PolitenessDeadlineReached(this.wallClockBudgetMs);
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      this.count += 1;
      this.byKind[kind] += 1;
    });
    // A refusal must not poison the chain for the next caller.
    this.tail = turn.catch(() => undefined);
    return turn;
  }
}
