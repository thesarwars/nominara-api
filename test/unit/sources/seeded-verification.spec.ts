import type { Job } from "bullmq";
import type { ClientBase, Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { nameUuid } from "../../../src/lib/ids/name-uuid.js";
import type { GuardedResponse } from "../../../src/lib/net/guarded-fetch.js";
import { signQueueJobPayload } from "../../../src/lib/queue/envelope.js";
import { handlerFor, type QueueHandlerContext } from "../../../src/lib/queue/handlers.js";
import { createSourceVerifyPresenceHandler } from "../../../src/lib/queue/handlers/source-verify-presence.handler.js";
import type { RotatingSigningKeys } from "../../../src/lib/queue/signing.js";
import { topologyFor } from "../../../src/lib/queue/topology.js";
import { createJobProcessor, phasesOf } from "../../../src/lib/queue/worker-factory.js";
import { seededTargetUrl } from "../../../src/lib/sources/verify-presence.js";

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

  it("is nothing when the task has no target URL — the domain's most-cited page is not the page the work was done on", () => {
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

  it("pins nothing for a task with no target URL, or one that is gone or no longer done by the time it commits", async () => {
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
