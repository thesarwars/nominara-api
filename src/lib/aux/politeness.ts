// STORY-049 AC7 / AC8 — the crawl's politeness budget for ONE host.
//
// aux-and-geo-analysis.md §1: "<= 2 requests per second per host with a 500 ms minimum interval, honours `Crawl-delay`,
// ... and hard-stops at the page cap". Nominara crawls only domains the customer verified, and a crawler that hammers a
// customer's site is a worse outcome than a crawler that is slow.
//
// ONE BUDGET FOR EVERY KIND OF REQUEST. The site files and the pages (both fetches) draw from the same budget. (The
// differential probe that once drew from it was removed on 2026-10-22: Nominara sends no request under another crawler's name.)
//
// 2 req/s and a 500 ms interval are the same constraint stated twice (an interval of 500 ms is at most 2 starts in any
// 1000 ms window), so ONE interval enforces both; a unit test checks the window directly rather than trusting the algebra.

/** aux-and-geo-analysis.md §1: a 500 ms minimum interval between requests to one host. */
export const MIN_INTERVAL_MS = 500;
/** aux-and-geo-analysis.md §1: at most 2 requests per second per host. */
export const MAX_REQUESTS_PER_SECOND = 2;

/**
 * NOT FROM THE REFERENCE (OWNER DECISION 2026-10-22). The longest Crawl-delay honoured. A declared delay up to this is honoured
 * exactly; a longer one is honoured as this, and the declared value is reported (`declaredCrawlDelayMs`,
 * `error_summary.crawl_delay_limited.declared_crawl_delay_ms`) so a reader can see the crawl was faster than asked. Why a cap
 * at all: honoured exactly, a hostile or careless `Crawl-delay: 86400` costs the audit llms.txt, the sitemap and every page,
 * because three waits that long fit no wall-clock budget. 60 s lets robots.txt, both llms files and the sitemap (about 4
 * minutes of waiting) fit inside CRAWL_WALL_CLOCK_BUDGET_MS with room for pages. Crawl-delay is not part of RFC 9309 and
 * Google ignores it entirely, so a 60 s ceiling is within common practice; the owner may change the number.
 */
export const MAX_HONOURED_CRAWL_DELAY_MS = 60_000;

export type RequestKind = "site_file" | "page";

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
  private declaredDelayMs = 0;
  private readonly deadline: number | null;
  private readonly wallClockBudgetMs: number;
  private lastStart: number | null = null;
  private count = 0;
  private readonly byKind: Record<RequestKind, number> = { site_file: 0, page: 0 };
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
   * value (negative, NaN, Infinity) is ignored; no declared delay can LOWER the 500 ms floor. A declared delay up to
   * MAX_HONOURED_CRAWL_DELAY_MS is honoured EXACTLY, rounded UP to a whole millisecond (a crawler that goes faster than the
   * site asked is not "honouring" it, and every duration in the audit record is an integer); a longer one is honoured as the
   * cap and reported by `declaredCrawlDelayMs`. A hostile 86400 s cannot pin a worker either way: `acquire` refuses before
   * sleeping when the wait would pass the wall-clock deadline, and `affordableRequests` shrinks the page list up front.
   */
  setCrawlDelay(seconds: number | null): void {
    const ms = seconds === null ? 0 : Math.ceil(seconds * 1000);
    this.declaredDelayMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
    this.crawlDelayMs = Math.min(this.declaredDelayMs, MAX_HONOURED_CRAWL_DELAY_MS);
  }

  /** The declared Crawl-delay in ms when it was longer than the cap and was shortened to it; null when honoured as declared. */
  get declaredCrawlDelayMs(): number | null {
    return this.declaredDelayMs > MAX_HONOURED_CRAWL_DELAY_MS ? this.declaredDelayMs : null;
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
