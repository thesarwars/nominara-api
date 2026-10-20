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

export type RequestKind = "site_file" | "page" | "probe";

/** The hard cap is spent. A typed error, never a silent skip: the caller records what it did not fetch. */
export class PolitenessCapReached extends Error {
  constructor(readonly cap: number) {
    super(`politeness: the hard cap of ${String(cap)} requests to this host is spent`);
    this.name = "PolitenessCapReached";
  }
}

export interface PolitenessOptions {
  /** The most requests of ALL kinds this crawl may make to the host. */
  readonly hardCap: number;
  /** The target's declared `Crawl-delay` in seconds, when robots.txt is already known. null/0 = none declared. */
  readonly crawlDelaySeconds?: number | null;
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
    this.setCrawlDelay(options.crawlDelaySeconds ?? null);
  }

  /**
   * robots.txt is the FIRST request, so its `Crawl-delay` is only known after it: call this once it is parsed. An unusable
   * value (negative, NaN, Infinity) is ignored; no declared delay can LOWER the 500 ms floor.
   */
  setCrawlDelay(seconds: number | null): void {
    this.crawlDelayMs = seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
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
   * Resolves when the caller may send ONE request, having waited out the interval since the previous start. Throws
   * `PolitenessCapReached` without waiting once the cap is spent; a refused request is not counted as made.
   */
  acquire(kind: RequestKind): Promise<void> {
    const turn = this.tail.then(async () => {
      if (this.count >= this.hardCap) throw new PolitenessCapReached(this.hardCap);
      if (this.lastStart !== null) {
        const wait = this.lastStart + this.intervalMs - this.now();
        if (wait > 0) await this.sleep(wait);
      }
      this.lastStart = this.now();
      this.count += 1;
      this.byKind[kind] += 1;
    });
    // A refusal must not poison the chain for the next caller.
    this.tail = turn.catch(() => undefined);
    return turn;
  }
}
