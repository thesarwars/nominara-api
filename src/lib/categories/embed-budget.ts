// STORY-189 AC7 / owner decision 107(b) - the spend limit on category-classification embedding.
//
// Two limits, both read from env with the documented defaults (src/config/env.schema.ts):
//   per project   the site text sent to the provider is trimmed to fit CATEGORY_EMBED_MAX_INPUT_TOKENS (default 2,000);
//   per day       a PLATFORM-WIDE ceiling, CATEGORY_EMBED_DAILY_TOKEN_CEILING (default 1,000,000), counted across every worker.
// Over the ceiling the site is "not classified" with a reason (the caller records it and alerts); the pass still completes.
//
// NOT CHARGED TO THE CUSTOMER: this is the platform's own spend. Nothing here or in its caller touches credits.
//
// HOW THE CEILING IS COUNTED. The site text's estimated tokens are RESERVED before the provider call (an atomic increment on
// the shared counter; over the ceiling the reservation is handed back and the call is not made), and the provider's reported
// total is settled afterwards, so the category vectors (embedded once per process and model) count too. Concurrent passes can
// overshoot by at most their own reservations. The counter store is injected: the worker gives it the queue Valkey (noeviction);
// without one a process-local counter applies, which still bounds each process.
//
// NO TOKENISER IS IMPORTED (no new dependency), so a token is estimated at ONE PER 3 CHARACTERS: more tokens than the usual four
// characters, so the estimate errs toward trimming and reserving too much, never too little.
//
// FAIL CLOSED: a counter that cannot be read refuses the call (reason `budget_unavailable`) rather than spending unmetered.

export const CATEGORY_EMBED_DEFAULT_MAX_INPUT_TOKENS = 2000;
export const CATEGORY_EMBED_DEFAULT_DAILY_CEILING = 1_000_000;
export const CATEGORY_EMBED_ALERT_NAME = "category_embed_daily_ceiling";
/** Characters per token for the estimate (see above). */
export const ESTIMATED_CHARS_PER_TOKEN = 3;
/** A day's counter outlives its day by a margin, then goes. */
const COUNTER_TTL_SECONDS = 48 * 60 * 60;

export const estimateTokens = (text: string): number => Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);

export interface TokenCounterStore {
  /** Adds `delta` (may be negative or zero) and returns the new total; the TTL is set when the key is created. */
  addAndGet(key: string, delta: number, ttlSeconds: number): Promise<number>;
}

export class InMemoryTokenCounterStore implements TokenCounterStore {
  private readonly totals = new Map<string, number>();
  addAndGet(key: string, delta: number, _ttlSeconds?: number): Promise<number> {
    const next = (this.totals.get(key) ?? 0) + delta;
    this.totals.set(key, next);
    return Promise.resolve(next);
  }
}

/** The subset of ioredis this needs, so the production store is testable without Valkey. */
export interface IncrByClient {
  multi(): { incrby(key: string, n: number): unknown; expire(key: string, seconds: number, mode: "NX"): unknown; exec(): Promise<[Error | null, unknown][] | null> };
}

export class ValkeyTokenCounterStore implements TokenCounterStore {
  constructor(
    private readonly redis: IncrByClient,
    private readonly keyPrefix: string,
  ) {}

  async addAndGet(key: string, delta: number, ttlSeconds: number): Promise<number> {
    const tx = this.redis.multi();
    const fullKey = `${this.keyPrefix}:${key}`;
    tx.incrby(fullKey, delta);
    tx.expire(fullKey, ttlSeconds, "NX");
    const replies = await tx.exec();
    const first = replies?.[0];
    if (first === undefined || first[0] !== null) throw new Error("token counter increment failed");
    return Number(first[1]);
  }
}

export type BudgetDecision =
  | { readonly status: "admitted"; readonly text: string; readonly reservedTokens: number }
  | { readonly status: "refused"; readonly reason: "daily_ceiling" | "budget_unavailable" };

export interface CategoryEmbedBudgetOptions {
  readonly store: TokenCounterStore;
  readonly maxInputTokens?: number;
  readonly dailyCeiling?: number;
  readonly clock?: () => number;
}

export class CategoryEmbedBudget {
  private readonly store: TokenCounterStore;
  private readonly maxInputTokens: number;
  private readonly dailyCeiling: number;
  private readonly clock: () => number;

  constructor(options: CategoryEmbedBudgetOptions) {
    this.store = options.store;
    this.maxInputTokens = options.maxInputTokens ?? CATEGORY_EMBED_DEFAULT_MAX_INPUT_TOKENS;
    this.dailyCeiling = options.dailyCeiling ?? CATEGORY_EMBED_DEFAULT_DAILY_CEILING;
    this.clock = options.clock ?? (() => Date.now());
  }

  /** The counter's key for the UTC day containing `atMs`. */
  dayKey(atMs: number = this.clock()): string {
    return `category-embed-tokens:${new Date(atMs).toISOString().slice(0, 10)}`;
  }

  get ceiling(): number {
    return this.dailyCeiling;
  }

  /** Trims the text to the per-project cap, then reserves its estimate against today's ceiling. */
  async admit(siteText: string): Promise<BudgetDecision> {
    const text = siteText.slice(0, this.maxInputTokens * ESTIMATED_CHARS_PER_TOKEN);
    const reservedTokens = estimateTokens(text);
    if (reservedTokens === 0) return { status: "admitted", text, reservedTokens: 0 };
    const key = this.dayKey();
    try {
      const total = await this.store.addAndGet(key, reservedTokens, COUNTER_TTL_SECONDS);
      if (total > this.dailyCeiling) {
        // Handed back, so a refused call does not use up the ceiling that the admitted ones are counted against.
        await this.store.addAndGet(key, -reservedTokens, COUNTER_TTL_SECONDS);
        return { status: "refused", reason: "daily_ceiling" };
      }
    } catch {
      return { status: "refused", reason: "budget_unavailable" };
    }
    return { status: "admitted", text, reservedTokens };
  }

  /** Replaces the reservation with what the provider reported. Best-effort: a failure here must not lose the classification. */
  async settle(reservedTokens: number, actualTokens: number): Promise<void> {
    const delta = actualTokens - reservedTokens;
    if (delta === 0) return;
    try {
      await this.store.addAndGet(this.dayKey(), delta, COUNTER_TTL_SECONDS);
    } catch {
      // The reservation already counted; only the correction is lost.
    }
  }
}
