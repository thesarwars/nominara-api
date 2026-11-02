import type { Job } from "bullmq";
import type { ClientBase, Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { guardedFetch } from "../../../src/lib/net/guarded-fetch.js";
import { NOMINARA_USER_AGENT } from "../../../src/lib/net/user-agent.js";
import { nameUuid } from "../../../src/lib/ids/name-uuid.js";
import type { GuardedResponse } from "../../../src/lib/net/guarded-fetch.js";
import { signQueueJobPayload } from "../../../src/lib/queue/envelope.js";
import { handlerFor, type QueueHandlerContext } from "../../../src/lib/queue/handlers.js";
import { createSourceVerifyPresenceHandler, identifiedFetcher } from "../../../src/lib/queue/handlers/source-verify-presence.handler.js";
import type { RotatingSigningKeys } from "../../../src/lib/queue/signing.js";
import { topologyFor } from "../../../src/lib/queue/topology.js";
import { createJobProcessor, phasesOf } from "../../../src/lib/queue/worker-factory.js";
import { projectQueueLockKey } from "../../../src/lib/queue/locks.js";
import { seededTargetUrl, seededVerificationUrl } from "../../../src/lib/sources/verify-presence.js";

vi.mock("../../../src/lib/net/guarded-fetch.js", async (importOriginal) => ({ ...(await importOriginal<object>()), guardedFetch: vi.fn() }));

// STORY-066 AC8 — `source_seeded` (`scoring-models.md` §13: "completion of an
// authority task with a verified target URL"; `aux-and-geo-analysis.md`
// "Verification closes the loop": worker-crawl fetches the URL and records the
// pin). The hazard: the pin must come from THE TASK'S target URL, fetched at
// completion, never from the domain's most-cited page on the periodic presence
// job (which is cached 30 days and is not the page the work was done on).

describe("STORY-066 AC8 · the URL a completed authority task is verified against", () => {
  it("is the task's own target URL when it is a page on the task's domain", () => {
    expect(seededTargetUrl("https://reviews.dev/acme", "reviews.dev")).toBe("https://reviews.dev/acme");
    expect(seededTargetUrl("https://www.reviews.dev/t/1", "reviews.dev")).toBe("https://www.reviews.dev/t/1");
    expect(seededTargetUrl("https://REVIEWS.dev/x", "reviews.dev.")).toBe("https://REVIEWS.dev/x");
  });

  it("is nothing on its own when the task has no target URL (the source-gap rule writes affected_url NULL)", () => {
    expect(seededTargetUrl(null, "reviews.dev")).toBeNull();
    expect(seededTargetUrl("", "reviews.dev")).toBeNull();
  });

  it("is nothing when the target is on another host (a page elsewhere cannot seed this domain), or is not http(s)", () => {
    expect(seededTargetUrl("https://other.dev/reviews.dev", "reviews.dev")).toBeNull();
    expect(seededTargetUrl("https://notreviews.dev/x", "reviews.dev")).toBeNull();
    expect(seededTargetUrl("ftp://reviews.dev/x", "reviews.dev")).toBeNull();
    expect(seededTargetUrl("not a url", "reviews.dev")).toBeNull();
  });
});

// Review round 2 — THE HAZARD the round-1 tests missed: the source-gap rule (taskgen `evaluateSourceGap`, `playbook.url: null`) is
// the ordinary producer of authority tasks, and it never sets `affected_url`. Completing such a task must still verify something,
// or AC8 never fires for the main seeding path. The recorded choice (option a): fall back to the domain's most-cited indexed page.
describe("STORY-066 AC8 · a source-gap authority task (affected_url NULL) is verified against the domain's most-cited indexed page", () => {
  it("prefers the task's own on-domain target, then the index's most-cited page on the domain", () => {
    expect(seededVerificationUrl("https://reviews.dev/threads/acme", "https://reviews.dev/best", "reviews.dev")).toBe("https://reviews.dev/threads/acme");
    expect(seededVerificationUrl(null, "https://reviews.dev/best", "reviews.dev")).toBe("https://reviews.dev/best");
    expect(seededVerificationUrl("https://elsewhere.dev/x", "https://www.reviews.dev/best", "reviews.dev")).toBe("https://www.reviews.dev/best");
  });

  it("is nothing when neither is an http(s) page on the task's domain", () => {
    expect(seededVerificationUrl(null, null, "reviews.dev")).toBeNull();
    expect(seededVerificationUrl(null, "https://other.dev/best", "reviews.dev")).toBeNull();
    expect(seededVerificationUrl("", "ftp://reviews.dev/best", "reviews.dev")).toBeNull();
  });
});

describe("STORY-066 AC8 / ADR-0003 · source.verify_presence is a phased job", () => {
  it("the registered handler is phased, so neither the periodic nor the completion fetch runs inside a transaction", () => {
    const factory = handlerFor("source.verify_presence");
    expect(factory).toBeDefined();
    const processor = factory!({ pool: undefined, env: {} } as unknown as QueueHandlerContext);
    expect(phasesOf(processor), "phased: the fetch runs with no transaction and no client").toBeDefined();
  });
});

// ─── The job itself, over a fake pool (no Docker): which statements run, and what is checked out during the fetch. ───

const WS = "11111111-1111-7111-8111-111111111111";
const PROJECT = "22222222-2222-7222-8222-222222222222";
const TASK = "33333333-3333-7333-8333-333333333333";
const DOMAIN_ID = "44444444-4444-7444-8444-444444444444";
const KEYS: RotatingSigningKeys = { current: { kid: "srcver-kid", key: Buffer.alloc(32, 7) } };
/** The task was completed yesterday; the job runs today (the domain's presence cache is still valid). */
const COMPLETED_AT = new Date("2026-10-25T09:30:00Z");
const JOB_NOW = new Date("2026-10-26T12:00:00Z");

const page = (text: string): GuardedResponse => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(`<p>${text}</p>`), finalUrl: "https://reviews.dev/" });

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function harness(options: { task?: Record<string, unknown> | null; alreadyPinned?: boolean; taskStillDone?: boolean } = {}) {
  const statements: Statement[] = [];
  let checkedOut = 0;
  const task =
    options.task === null
      ? null
      : {
          task_id: TASK,
          source_domain_id: DOMAIN_ID,
          domain: "reviews.dev",
          affected_url: "https://reviews.dev/threads/acme",
          completed_at: COMPLETED_AT,
          workspace_id: WS,
          name: "Acme Analytics",
          brand_aliases: ["Acme"],
          negative_aliases: [],
          index_top_url: null,
          pinned: options.alreadyPinned ?? false,
          today: "2026-10-26",
          ...options.task,
        };
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      if (/FROM tasks t\b/u.test(sql)) return { rows: task === null ? [] : [task], rowCount: task === null ? 0 : 1 };
      if (/FROM tasks\s+WHERE id = \$1/u.test(sql)) return { rows: options.taskStillDone === false ? [] : [{ id: TASK }], rowCount: 1 };
      // The periodic run: the project, then one candidate (the domain's most-cited page, verified long ago).
      if (/FROM projects WHERE id = \$1 AND deleted_at IS NULL/u.test(sql))
        return { rows: [{ workspace_id: WS, name: "Acme Analytics", brand_aliases: ["Acme"], negative_aliases: [] }], rowCount: 1 };
      if (/FROM project_source_index psi JOIN source_domains/u.test(sql))
        return { rows: [{ source_domain_id: DOMAIN_ID, domain: "reviews.dev", top_url: "https://reviews.dev/best", verified_at: null, context_weight: 1 }], rowCount: 1 };
      if (/AT TIME ZONE w\.timezone/u.test(sql)) return { rows: [{ today: "2026-10-26" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }),
  } as unknown as ClientBase;
  return {
    statements,
    context: { pool: { connect: vi.fn(async () => client) } as unknown as Pool, env: {} as never } satisfies QueueHandlerContext,
    get checkedOut() {
      return checkedOut;
    },
    getClient: () => {
      checkedOut += 1;
      return client;
    },
    releaseClient: () => {
      checkedOut -= 1;
    },
  };
}

function processor(h: ReturnType<typeof harness>, fetch: (url: string) => Promise<GuardedResponse>) {
  return createJobProcessor(topologyFor("source.verify_presence"), {
    keys: KEYS,
    getClient: h.getClient,
    releaseClient: h.releaseClient,
    process: createSourceVerifyPresenceHandler(h.context, { fetch, now: () => JOB_NOW }),
  });
}

const job = (payload: Record<string, unknown>): Job =>
  ({ data: signQueueJobPayload({ workspaceId: WS, kid: KEYS.current.kid, projectId: PROJECT, ...payload }, KEYS.current.key) }) as unknown as Job;

const milestoneInserts = (h: ReturnType<typeof harness>) => h.statements.filter((s) => /INSERT INTO milestones/u.test(s.sql));

describe("STORY-066 AC8 · completing an authority task verifies ITS target and pins source_seeded at the completion", () => {
  it("fetches the task's target URL with no client checked out, and pins at completed_at — not at the verification", async () => {
    const h = harness();
    const fetched: { url: string; checkedOut: number }[] = [];
    await processor(h, async (url) => {
      // Recorded, not asserted here: the presence check turns a throwing fetch into a "failed" outcome and would hide it.
      fetched.push({ url, checkedOut: h.checkedOut });
      return page("Acme Analytics answered here");
    })(job({ taskId: TASK }));

    expect(fetched, "the task's target, fetched with no pooled connection held (ADR-0003)").toEqual([{ url: "https://reviews.dev/threads/acme", checkedOut: 0 }]);
    const [pin, ...rest] = milestoneInserts(h);
    expect(rest).toEqual([]);
    expect(pin!.sql).toContain("'source_seeded'");
    expect(pin!.params).toContain(COMPLETED_AT);
    expect(pin!.params).not.toContain(JOB_NOW);
    expect(pin!.params).toContain(nameUuid("source_seeded", PROJECT, TASK));
    // The verified page is a fact about the domain: its presence is recorded, so the gap closes at the next index computation.
    expect(h.statements.some((s) => /UPDATE project_source_index SET brand_present_on_domain/u.test(s.sql))).toBe(true);
    expect(h.checkedOut).toBe(0);
  });

  it("the 30-day presence cache does not apply: a domain verified absent yesterday is still fetched at completion", async () => {
    // The task row carries no verification state at all, so nothing in the seeded path can skip on the cache.
    const h = harness();
    const fetch = vi.fn(async () => page("Acme Analytics"));
    await processor(h, fetch)(job({ taskId: TASK }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a redelivery after the pin exists fetches nothing and pins nothing more", async () => {
    const h = harness({ alreadyPinned: true });
    const fetch = vi.fn(async () => page("Acme Analytics"));
    await processor(h, fetch)(job({ taskId: TASK }));
    expect(fetch).not.toHaveBeenCalled();
    expect(milestoneInserts(h)).toEqual([]);
  });

  it("pins nothing when the target page does not carry the brand", async () => {
    const h = harness();
    await processor(h, async () => page("Only Globex here"))(job({ taskId: TASK }));
    expect(milestoneInserts(h)).toEqual([]);
  });

  it("a source-gap task (affected_url NULL, as the source-gap rule writes it) fetches the domain's most-cited page and pins", async () => {
    const h = harness({ task: { affected_url: null, index_top_url: "https://reviews.dev/best" } });
    const fetch = vi.fn(async () => page("Acme Analytics"));
    await processor(h, fetch)(job({ taskId: TASK }));
    expect(fetch).toHaveBeenCalledWith("https://reviews.dev/best");
    const [pin, ...rest] = milestoneInserts(h);
    expect(rest).toEqual([]);
    expect(pin!.params).toContain(COMPLETED_AT);
  });

  it("pins nothing for a task with no target URL and no indexed page on its domain, or one that is gone or no longer done by the time it commits", async () => {
    for (const h of [harness({ task: { affected_url: null } }), harness({ task: null }), harness({ taskStillDone: false })]) {
      await processor(h, async () => page("Acme Analytics"))(job({ taskId: TASK }));
      expect(milestoneInserts(h)).toEqual([]);
    }
  });

  it("a fetch that errors FAILS the job so the queue retries it — an outage is neither a pin nor a final no", async () => {
    const h = harness();
    await expect(
      processor(h, async () => {
        throw new Error("ECONNRESET");
      })(job({ taskId: TASK })),
    ).rejects.toThrow();
    expect(milestoneInserts(h)).toEqual([]);
    expect(h.checkedOut).toBe(0);
  });

  it("the periodic run fetches with no client checked out, and NEVER pins source_seeded (its page is the domain's most-cited one)", async () => {
    const h = harness();
    const heldDuringFetch: number[] = [];
    await processor(h, async () => {
      heldDuringFetch.push(h.checkedOut);
      return page("Acme Analytics");
    })(job({}));
    expect(heldDuringFetch, "no pooled connection is held across the periodic fetch (ADR-0003)").toEqual([0]);
    expect(h.statements.some((s) => /UPDATE project_source_index SET brand_present_on_domain/u.test(s.sql)), "the periodic run did verify").toBe(true);
    expect(milestoneInserts(h)).toEqual([]);
  });
});

// Review round 2 — LOST UPDATE. `refreshProjectSourceIndex` reads the presence it carries over and then DELETEs and re-inserts the
// project's index; the rollup runs it under its per-project advisory lock. A presence write that does not take the SAME lock can
// UPDATE rows a concurrent rollup has already deleted (0 rows, unnoticed), and then carry the rollup's stale "absent" across. So
// both presence commits take the rollup's lock FIRST — before any row lock, so the order matches the rollup's (advisory lock, then
// the `projects` row its denormalisation updates) and the two can never deadlock.
describe("STORY-066 AC8 · both presence commits serialise with rollup.metric_daily on the project's advisory lock", () => {
  const ROLLUP_LOCK = projectQueueLockKey("rollup.metric_daily", PROJECT);
  const indexOf = (h: ReturnType<typeof harness>, pattern: RegExp) => h.statements.findIndex((s) => pattern.test(s.sql));
  const lockIndex = (h: ReturnType<typeof harness>) =>
    h.statements.findIndex((s) => /pg_advisory_xact_lock/u.test(s.sql) && s.params.includes(ROLLUP_LOCK));

  it("the seeded commit takes the rollup's lock before the task row lock and before it writes presence", async () => {
    const h = harness();
    await processor(h, async () => page("Acme Analytics"))(job({ taskId: TASK }));
    const lock = lockIndex(h);
    expect(lock, "the rollup's per-project lock is taken").toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(indexOf(h, /FROM tasks\s+WHERE id = \$1[\s\S]*FOR NO KEY UPDATE/u));
    expect(lock).toBeLessThan(indexOf(h, /UPDATE project_source_index SET brand_present_on_domain/u));
  });

  it("the periodic commit takes the rollup's lock before the project row lock and before it writes presence", async () => {
    const h = harness();
    await processor(h, async () => page("Acme Analytics"))(job({}));
    const lock = lockIndex(h);
    expect(lock, "the rollup's per-project lock is taken").toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(indexOf(h, /FROM projects WHERE id = \$1 AND deleted_at IS NULL FOR NO KEY UPDATE/u));
    expect(lock).toBeLessThan(indexOf(h, /UPDATE project_source_index SET brand_present_on_domain/u));
  });
});

// STORY-055 review round 7 / STORY-049 AC7 - Wikipedia and Reddit answered 403 to a fetch that did not identify itself.
describe("STORY-055 / STORY-049 AC7 - the seeding fetches identify themselves", () => {
  const headers = { "user-agent": NOMINARA_USER_AGENT, accept: "text/html,application/xhtml+xml" };

  it("the identified fetcher sends the Nominara User-Agent and Accept on the page and on the canary, keeping the redirect rule", async () => {
    const guarded = vi.fn(async () => page("x"));
    const followRedirect = () => true;
    const fetch = identifiedFetcher(guarded);
    await fetch("https://en.wikipedia.org/wiki/Acme", { followRedirect });
    await fetch("https://en.wikipedia.org/wiki/Acme-canary-nonce");
    expect(guarded).toHaveBeenNthCalledWith(1, "https://en.wikipedia.org/wiki/Acme", { followRedirect, headers });
    expect(guarded).toHaveBeenNthCalledWith(2, "https://en.wikipedia.org/wiki/Acme-canary-nonce", { headers });
  });

  it("the identified fetcher keeps a caller's header, and our User-Agent and Accept win over the caller's", async () => {
    const guarded = vi.fn(async () => page("x"));
    await identifiedFetcher(guarded)("https://en.wikipedia.org/wiki/Acme", { headers: { "x-trace": "abc", "user-agent": "evil", accept: "*/*" } });
    expect(guarded).toHaveBeenCalledWith("https://en.wikipedia.org/wiki/Acme", { headers: { "x-trace": "abc", ...headers } });
  });

  it("the handler's default fetcher (periodic verify-presence path) is that identified fetcher", async () => {
    const mocked = vi.mocked(guardedFetch);
    mocked.mockReset();
    mocked.mockResolvedValue(page("Acme Analytics"));
    const h = harness();
    await createJobProcessor(topologyFor("source.verify_presence"), {
      keys: KEYS,
      getClient: h.getClient,
      releaseClient: h.releaseClient,
      process: createSourceVerifyPresenceHandler(h.context, { now: () => JOB_NOW }),
    })(job({}));
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0]![1]).toMatchObject({ headers });
  });
});
