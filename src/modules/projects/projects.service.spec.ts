import { beforeEach, describe, expect, it, vi } from "vitest";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { ProjectsService } from "./projects.service.js";
import { DomainError } from "../../api/errors/domain-errors.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import type { QueueProducer } from "../../lib/queue/queue-producer.js";
import type { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { GuardedFetchRefusal } from "../../lib/net/guarded-fetch.js";
import { isGloballyReachable } from "../../lib/net/address-rules.js";
import { toRegistrableDomain } from "../../lib/net/registrable-domain.js";
import type { UrlGuard } from "../../lib/net/url-guard.service.js";

vi.mock("../../lib/telemetry/metrics.js", () => ({ incrementCounter: vi.fn() }));

// STORY-043 — the unit-level half. Scenarios needing real RLS and a real
// worker are integration; these are the ones about ORDER and REFUSAL, which
// are decidable from what the service calls and in what sequence.

interface Recorded {
  readonly sql: string;
  readonly params: unknown[];
}

function tenantClientRecording(calls: Recorded[], rows: unknown[] = []) {
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      // The embedding request (STORY-133) asks which of the new prompts still lack a vector; this stub's catch-all row has no id.
      if (sql.includes("embedding IS NULL")) return { rows: [] };
      return { rows };
    }),
  };
}

/**
 * A resolver answering `entitlements`. `projects.max` (3) is always present, as every real resolution carries it: since
 * STORY-077 (owner 2026-10-23) every creation re-counts it under the workspace lock, and a missing key reads as 0.
 */
function resolverReturning(entitlements: Record<string, { value: unknown }>): EntitlementResolver {
  const resolved = { "projects.max": { value: 3 }, ...entitlements };
  return {
    resolveForWorkspace: vi.fn(async () => ({ entitlements: resolved })),
    resolve: vi.fn(async () => ({ entitlements: resolved })),
  } as unknown as EntitlementResolver;
}

const GENEROUS = {
  "prompts.max_per_project": { value: 500 },
  "competitors.max_per_project": { value: 200 },
};

/**
 * The real scheme/port/address rules and the real normaliser, with DNS
 * replaced by "the hostname IS the address if it looks like one".
 *
 * Not a hand-written stub returning canned answers: that would let this suite
 * pass while the service mishandled a refusal shape the real guard produces.
 * Only the network is faked — every rule under test is STORY-131's own.
 */
const urlGuard: UrlGuard = {
  validateAndNormalize: async (rawUrl: string) => {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new GuardedFetchRefusal("scheme_not_allowed");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // A literal address is checked with the real rules; a NAME is treated as
    // resolving to something public, which is what a unit test wants to assume.
    if (/^[0-9a-f:.]+$/i.test(host) && !isGloballyReachable(host)) {
      throw new GuardedFetchRefusal("address_not_global");
    }
    return { rootDomain: toRegistrableDomain(rawUrl) };
  },
};

const WS = "11111111-1111-7111-8111-111111111111";
const ACTOR = "22222222-2222-7222-8222-222222222222";

describe("STORY-043 · ProjectsService.create", () => {
  let calls: Recorded[];
  let deferred: (() => void)[];
  let queues: QueueProducer;

  beforeEach(() => {
    calls = [];
    deferred = [];
    queues = { enqueueTenantJob: vi.fn(async () => ({ id: "job-1" })) } as unknown as QueueProducer;
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: tenantClientRecording(calls, [{ "?column?": 1 }]),
    } as never);
    // Captured rather than run, so a test can assert the enqueue was DEFERRED
    // and then choose to fire it.
    vi.spyOn(tenantContext, "afterCommit").mockImplementation((task: () => void) => {
      deferred.push(task);
    });
  });

  const service = () => new ProjectsService(queues, resolverReturning(GENEROUS), urlGuard);

  it("scenario 1 — creates from a URL alone and returns a poll pointer", async () => {
    const result = await service().create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1);

    expect(result.root_domain).toBe("hubspot.com");
    expect(result.status).toBe("initializing");
    expect(result.discovery_status).toBe("pending");
    expect(result.poll.discovery).toBe(`/v1/projects/${result.project_id}/discovery`);
    expect(result.poll.expected_ms).toBeGreaterThan(0);
  });

  it("scenario 12 — normalises a subdomain and tracking parameters to the registrable domain", async () => {
    const result = await service().create(
      WS,
      ACTOR,
      { root_url: "https://www.blog.bbc.co.uk/news?utm_source=x#frag" },
      1,
    );
    expect(result.root_domain).toBe("bbc.co.uk");
  });

  // AC8 — the whole design. Asserted on the RECORDED SEQUENCE, because a
  // comment saying "insert first" is not a test and the reverse order is a
  // one-line edit away.
  it("scenario 8/AC8 — inserts the project BEFORE the crawl is enqueued", async () => {
    await service().create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1);

    expect(calls.some((c) => c.sql.includes("INSERT INTO projects"))).toBe(true);
    // Nothing enqueued yet: it is deferred past COMMIT.
    expect(queues.enqueueTenantJob).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(1);
  });

  it("AC8 — the enqueue is deferred past COMMIT, not run inside the transaction", async () => {
    const result = await service().create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1);
    expect(queues.enqueueTenantJob).not.toHaveBeenCalled();

    deferred[0]!();
    await vi.waitFor(() => expect(queues.enqueueTenantJob).toHaveBeenCalledOnce());

    const [name, workspaceId, payload, options] = vi.mocked(queues.enqueueTenantJob).mock.calls[0]!;
    expect(name).toBe("crawl.discover");
    expect(workspaceId).toBe(WS);
    expect(payload).toMatchObject({ projectId: result.project_id, rootUrl: "https://hubspot.com" });
    // topology.ts's documented pattern for this queue — one discovery per
    // project, so a retried creation cannot start a second.
    expect(options.idempotencyKey).toBe(`disc:${result.project_id}`);
  });

  it("STORY-077 (owner 2026-10-23) — every creation takes the workspace lock BEFORE it re-counts projects.max, and is refused at the limit", async () => {
    await service().create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1);
    const lock = calls.findIndex((c) => c.sql.includes("FROM workspaces WHERE id = $1 FOR UPDATE"));
    const count = calls.findIndex((c) => c.sql.includes("FROM projects WHERE workspace_id = $1 AND status IN ('active', 'initializing')"));
    expect(lock, "the workspace lock is taken").toBeGreaterThanOrEqual(0);
    expect(count, "projects.max is re-counted").toBeGreaterThan(lock);

    calls.length = 0;
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client: tenantClientRecording(calls, [{ n: 3 }]) } as never);
    const error = await service().create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1).catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("entitlement_exceeded");
    expect((error as DomainError).details).toEqual({ key: "projects.max", limit: 3, current: 3 });
    expect(calls.some((c) => c.sql.includes("INSERT INTO projects")), "nothing is inserted").toBe(false);
  });

  // Review round 2 (minor): every creation now takes the workspace lock, and a wait past its bound was counted as
  // nominara_workspace_lock_wait_exceeded_total{path="prompt_activation"}, so POST /projects' 503s were reported under
  // the wrong path. The creation names its own.
  it("STORY-077 — a creation's lock-wait timeout is a 503 counted under path=\"project_create\"", async () => {
    vi.mocked(incrementCounter).mockClear();
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM workspaces WHERE id = $1 FOR UPDATE")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
          return { rows: [{ "?column?": 1 }] };
        }),
      },
    } as never);
    const error = await service().create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1).catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("degraded");
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_workspace_lock_wait_exceeded_total", { path: "project_create" });
    expect(vi.mocked(incrementCounter)).not.toHaveBeenCalledWith("nominara_workspace_lock_wait_exceeded_total", { path: "prompt_activation" });
  });

  it("a failing enqueue does not fail the creation — the project already exists", async () => {
    queues = { enqueueTenantJob: vi.fn(async () => { throw new Error("redis down"); }) } as unknown as QueueProducer;
    await expect(service().create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1)).resolves.toBeDefined();
    expect(() => { deferred[0]!(); }).not.toThrow();
  });

  // Scenario 11 — the guarded fetcher's refusal, surfaced as 422.
  it.each([
    ["http://127.0.0.1/", "loopback"],
    ["http://169.254.169.254/", "cloud metadata"],
    ["http://10.0.0.1/", "RFC1918"],
  ])("scenario 11 — refuses %s (%s) with 422 and creates no project", async (url) => {
    const error = await service().create(WS, ACTOR, { root_url: url }, 1).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("unsafe_target");
    expect((error as DomainError).getStatus()).toBe(422);
    // "in every failure case the project is not created" (§4.4).
    expect(calls.some((c) => c.sql.includes("INSERT INTO projects"))).toBe(false);
    expect(deferred).toHaveLength(0);
  });

  it("scenario 11 — the 422's details name the check, never the address", () => {
    return service()
      .create(WS, ACTOR, { root_url: "http://169.254.169.254/" }, 1)
      .catch((error: unknown) => {
        const details = JSON.stringify((error as DomainError).details);
        expect(details).toContain("address_not_global");
        expect(details).not.toContain("169.254");
      });
  });

  // Scenario 9 — the cap refusal, and the "no project created" half of it.
  it("scenario 9 — refuses more prompts than the cap, naming the cap, creating nothing", async () => {
    const svc = new ProjectsService(queues, resolverReturning({ "prompts.max_per_project": { value: 2 } }), urlGuard);
    const error = await svc
      .create(WS, ACTOR, { root_url: "https://hubspot.com", prompts: [{ text: "a" }, { text: "b" }, { text: "c" }] }, 1)
      .catch((e: unknown) => e);

    expect((error as DomainError).code).toBe("entitlement_exceeded");
    expect((error as DomainError).details).toMatchObject({ key: "prompts.max_per_project", limit: 2, current: 3 });
    expect(calls.some((c) => c.sql.includes("INSERT INTO projects"))).toBe(false);
  });

  it("scenario 9 — the same for competitors", async () => {
    const svc = new ProjectsService(queues, resolverReturning({ "competitors.max_per_project": { value: 1 } }), urlGuard);
    const error = await svc
      .create(WS, ACTOR, { root_url: "https://hubspot.com", competitors: [{ name: "A" }, { name: "B" }] }, 1)
      .catch((e: unknown) => e);

    expect((error as DomainError).details).toMatchObject({ key: "competitors.max_per_project", limit: 1, current: 2 });
    expect(calls.some((c) => c.sql.includes("INSERT INTO projects"))).toBe(false);
  });

  // AC5 — "stored as user-authored and manual respectively", and charging
  // nothing. The absence of any wallet call is the assertion that matters.
  it("scenario 8 — supplied competitors are user-authored and prompts manual", async () => {
    await service().create(
      WS,
      ACTOR,
      { root_url: "https://hubspot.com", competitors: [{ name: "Salesforce" }], prompts: [{ text: "best crm" }] },
      1,
    );

    // *** THIS ASSERTION USED TO READ `c.sql.includes("user_authored")`, AND
    //     THE SUBSTRING IT CHECKED FOR WAS ITSELF THE BUG. ***
    //
    // The statement named a column that does not exist (`origin`, where the
    // table has `source`) and a value its CHECK forbids (`'user_authored'`
    // against `CHECK (source IN ('user','auto_detected'))`) — so supplying
    // any competitor at creation answered 500 from the day it shipped. A
    // substring check against a stubbed client passed anyway, and passed
    // BECAUSE the wrong value was present.
    //
    // What is checkable here is the bound PARAMETERS. The executable proof is
    // in test/integration/project-seeds.spec.ts.
    const competitorInsert = calls.find((c) => c.sql.includes("INSERT INTO competitors"));
    expect(competitorInsert).toBeDefined();
    expect(competitorInsert?.params).toContain("user");
    expect(competitorInsert?.sql).toContain("source");
    expect(competitorInsert?.sql).not.toContain("origin");

    // *** THIS ASSERTION USED TO READ `c.sql.includes("'manual'")`, AND THAT
    //     IS WHY A BROKEN INSERT SHIPPED. ***
    //
    // The statement supplied three columns and `tracked_prompts` has three
    // more that are NOT NULL with no default, so it could never execute — and
    // a substring check against a stubbed client passed anyway. The
    // executable proof now lives in
    // test/integration/promptgen-persist.spec.ts; what is checkable HERE is
    // that the row carries the right provenance, which is a value in the
    // parameters rather than a literal in the SQL.
    const promptInsert = calls.find((c) => c.sql.includes("INSERT INTO tracked_prompts"));
    expect(promptInsert).toBeDefined();
    expect(promptInsert?.params).toContain("manual");
    expect(promptInsert?.params).toContain("custom");
    for (const column of ["text_hash", "intent_archetype", "funnel_stage"]) {
      expect(promptInsert?.sql, column).toContain(column);
    }
  });

  it("STORY-133 AC10 - supplied prompts (inserted active) are requested for embedding in the creation, and enqueued only after COMMIT", async () => {
    calls.length = 0;
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          if (sql.includes("embedding IS NULL")) return { rows: (params[0] as string[]).map((id) => ({ id })) };
          return { rows: [{ "?column?": 1 }] };
        }),
      },
    } as never);
    await service().create(WS, ACTOR, { root_url: "https://hubspot.com", prompts: [{ text: "best crm" }, { text: "cheap crm" }] }, 1);

    const order = calls.map((c) => c.sql);
    const lastInsert = order.map((sql, i) => (sql.includes("INSERT INTO tracked_prompts") ? i : -1)).reduce((a, b) => Math.max(a, b));
    const request = order.findIndex((sql) => sql.includes("embedding IS NULL"));
    expect(request, "requested after the prompts are written").toBeGreaterThan(lastInsert);
    const embedCalls = () => (queues.enqueueTenantJob as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "embed.batch");
    expect(embedCalls(), "nothing is enqueued before COMMIT").toHaveLength(0);
    for (const task of deferred) task();
    await Promise.resolve();
    expect(embedCalls()).toHaveLength(1);
    expect((embedCalls()[0]![2] as { ids: string[] }).ids).toHaveLength(2);
  });

  it("STORY-133 AC10 - a creation with no prompts requests no embedding", async () => {
    await service().create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1);
    expect(calls.some((c) => c.sql.includes("embedding IS NULL"))).toBe(false);
  });

  it("scenario 15 — creation touches no wallet or ledger table", async () => {
    await service().create(
      WS,
      ACTOR,
      { root_url: "https://hubspot.com", prompts: [{ text: "a" }, { text: "b" }] },
      1,
    );
    const touched = calls.map((c) => c.sql).join(" ").toLowerCase();
    for (const table of ["wallet", "credit_ledger", "ledger_entries", "debit"]) {
      expect(touched, `create must not touch ${table}`).not.toContain(table);
    }
  });

  // AC4 — echoes exactly what the caller supplied, so a client renders
  // "discovering" only for the rest.
  it("scenario 5 — fields_supplied echoes the supplied optional fields, and only those", async () => {
    const result = await service().create(
      WS,
      ACTOR,
      { root_url: "https://hubspot.com", name: "HubSpot", category_slug: "crm", prompts: [{ text: "x" }] },
      1,
    );
    expect(result.fields_supplied).toEqual(["name", "category_slug", "prompts"]);
  });

  it("scenario 5 — a URL-only creation supplies nothing", async () => {
    const result = await service().create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1);
    expect(result.fields_supplied).toEqual([]);
  });

  // THE 500. `ux_projects_ws_slug` is unique on (workspace_id, slug) and the
  // slug was the bare domain, so a SECOND project on the same site died with a
  // raw Postgres 23505. Two projects on one domain is not a mistake:
  // kind='product_line' exists so a brand and its product lines can share a
  // site, and they necessarily share a root_domain.
  it("suffixes the slug when the domain is already taken in this workspace", async () => {
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          if (sql.includes("SELECT slug FROM projects")) return { rows: [{ slug: "hubspot.com" }] };
          return { rows: [] };
        }),
      },
    } as never);
    const svc = new ProjectsService(queues, resolverReturning(GENEROUS), urlGuard);

    await svc.create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1);

    const insert = calls.find((c) => c.sql.includes("INSERT INTO projects"))!;
    expect(insert.params).toContain("hubspot.com-2");
  });

  it("skips over every taken suffix rather than reusing one", async () => {
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          if (sql.includes("SELECT slug FROM projects")) {
            return { rows: [{ slug: "hubspot.com" }, { slug: "hubspot.com-2" }, { slug: "hubspot.com-3" }] };
          }
          return { rows: [] };
        }),
      },
    } as never);
    const svc = new ProjectsService(queues, resolverReturning(GENEROUS), urlGuard);

    await svc.create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1);

    const insert = calls.find((c) => c.sql.includes("INSERT INTO projects"))!;
    expect(insert.params).toContain("hubspot.com-4");
  });

  it("reports a racing duplicate as a conflict, not a 500", async () => {
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          if (sql.includes("SELECT slug FROM projects")) return { rows: [] };
          if (sql.includes("INSERT INTO projects")) {
            // What a concurrent create looks like: the slug was free when we
            // checked and taken by the time we wrote.
            throw Object.assign(new Error("duplicate key"), { code: "23505", constraint: "ux_projects_ws_slug" });
          }
          return { rows: [] };
        }),
      },
    } as never);
    const svc = new ProjectsService(queues, resolverReturning(GENEROUS), urlGuard);

    const error = await svc.create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1).catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("conflict");
    expect((error as DomainError).getStatus()).toBe(409);
  });

  it("does not swallow a DIFFERENT unique violation as a slug conflict", async () => {
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          if (sql.includes("SELECT slug FROM projects")) return { rows: [] };
          if (sql.includes("INSERT INTO projects")) {
            throw Object.assign(new Error("duplicate key"), { code: "23505", constraint: "some_other_index" });
          }
          return { rows: [] };
        }),
      },
    } as never);
    const svc = new ProjectsService(queues, resolverReturning(GENEROUS), urlGuard);

    const error = await svc.create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1).catch((e: unknown) => e);
    // Mislabelling an unrelated constraint as "try again" would send a caller
    // into a retry loop over something retrying cannot fix.
    expect((error as { code?: string }).code).toBe("23505");
  });

  it("uses the registrable domain as the placeholder name when none is supplied", async () => {
    await service().create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO projects"))!;
    expect(insert.params).toContain("hubspot.com");
  });

  it("keeps a supplied name instead of the domain", async () => {
    await service().create(WS, ACTOR, { root_url: "https://hubspot.com", name: "HubSpot CRM" }, 1);
    const insert = calls.find((c) => c.sql.includes("INSERT INTO projects"))!;
    expect(insert.params).toContain("HubSpot CRM");
  });

  // This test previously asserted the OPPOSITE — that null means unlimited —
  // and passed, because it was written against the implementation rather than
  // against the specification. plans-and-entitlements.md and
  // classification.ts:133-137 both say null is "no allowance at all", naming
  // this exact key: "free carries null for prompts.max_per_project because it
  // has no projects to put prompts in."
  it("treats a null cap as NO allowance, not as unlimited", async () => {
    const svc = new ProjectsService(queues, resolverReturning({ "prompts.max_per_project": { value: null } }), urlGuard);
    const error = await svc
      .create(WS, ACTOR, { root_url: "https://hubspot.com", prompts: [{ text: "a" }] }, 1)
      .catch((e: unknown) => e);

    expect((error as DomainError).code).toBe("entitlement_exceeded");
    expect((error as DomainError).details).toMatchObject({ limit: 0, current: 1 });
  });

  it("a null cap still allows a project with no prompts — the cap binds prompts, not creation", async () => {
    const svc = new ProjectsService(queues, resolverReturning({ "prompts.max_per_project": { value: null } }), urlGuard);
    await expect(svc.create(WS, ACTOR, { root_url: "https://hubspot.com" }, 1)).resolves.toBeDefined();
  });

  // THE 500. `structuralLimitFrom` resolves "custom" to unlimited, so an
  // enterprise workspace passes the projects.max guard and reaches the service
  // — where the old hand-rolled resolver returned MAX_SAFE_INTEGER and bound
  // it into `prompts_cap`, a smallint. Postgres refused with 22003 AFTER the
  // URL guard and both cap checks had passed, so every enterprise project
  // creation answered 500 on an otherwise valid request.
  it("does not overflow the smallint column on an enterprise 'custom' cap", async () => {
    const svc = new ProjectsService(
      queues,
      resolverReturning({
        "prompts.max_per_project": { value: "custom" },
        "competitors.max_per_project": { value: "custom" },
      }),
      urlGuard,
    );
    const result = await svc.create(WS, ACTOR, { root_url: "https://hubspot.com", prompts: [{ text: "a" }] }, 1);

    expect(result.prompts_cap).toBe(32767);
    expect(result.prompts_cap).toBeLessThanOrEqual(32767); // smallint's own ceiling
    const insert = calls.find((c) => c.sql.includes("INSERT INTO projects"))!;
    expect(insert.params).not.toContain(Number.MAX_SAFE_INTEGER);
  });

  it("an unrecognised entitlement value fails closed at zero, not open at unlimited", async () => {
    // A value nobody classified is a configuration defect, and the safe
    // reading of a defect is "grant nothing".
    const svc = new ProjectsService(queues, resolverReturning({ "prompts.max_per_project": { value: "???" } }), urlGuard);
    const error = await svc
      .create(WS, ACTOR, { root_url: "https://hubspot.com", prompts: [{ text: "a" }] }, 1)
      .catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("entitlement_exceeded");
  });
});

// STORY-043 scenario 2 — "read the project before discovery finishes:
// usable, initialising, discovery running."
describe("STORY-043 · ProjectsService.discoveryFor", () => {
  let calls: Recorded[];

  function serviceReading(rows: unknown[]) {
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: tenantClientRecording(calls, rows),
    } as never);
    return new ProjectsService(
      { enqueueTenantJob: vi.fn() } as unknown as QueueProducer,
      resolverReturning(GENEROUS),
      urlGuard,
    );
  }

  it("scenario 2 — before discovery has written anything, reports pending and is not a 404", async () => {
    const result = await serviceReading([{ discovery: {}, discovery_status: "pending" }]).discoveryFor("p1");

    expect(result.discovery_status).toBe("pending");
    expect(result.fields).toEqual({});
    expect(result.duration_ms).toBeNull();
    expect(result.credits_charged).toBe(0);
  });

  it("scenario 2 — reports running while the handler is mid-flight", async () => {
    const result = await serviceReading([{ discovery: {}, discovery_status: "running" }]).discoveryFor("p1");
    expect(result.discovery_status).toBe("running");
  });

  it("returns the written payload once discovery has completed", async () => {
    const written = {
      discovery_status: "completed",
      duration_ms: 17420,
      fields: { brand_name: { value: "HubSpot", confidence: 0.96, source: "Organization schema", user_edited: false } },
      competitors_proposed: [],
      prompts_generated: [],
      prompts_free_remaining: 10,
      credits_charged: 0,
      low_confidence_fields: [],
    };
    const result = await serviceReading([{ discovery: written, discovery_status: "completed" }]).discoveryFor("p1");

    expect(result).toEqual(written);
  });

  it("404s for a project that does not exist, or belongs to another tenant", async () => {
    // RLS makes the two indistinguishable here, which is the intent — a 404
    // that differed from a 403 would confirm the row exists.
    const error = await serviceReading([]).discoveryFor("p1").catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("not_found");
    expect((error as DomainError).getStatus()).toBe(404);
  });

  it("takes no workspace_id predicate — RLS scopes the read (NFR-SEC-01)", async () => {
    await serviceReading([{ discovery: {}, discovery_status: "pending" }]).discoveryFor("p1");
    for (const call of calls) {
      expect(call.sql).not.toContain("workspace_id");
    }
  });
});

// STORY-044 — confirm and override.
describe("STORY-044 · ProjectsService.confirmDiscovery", () => {
  let calls: Recorded[];

  const DISCOVERED = {
    discovery_status: "completed",
    duration_ms: 1200,
    fields: {
      brand_name: { value: "HubSpot", confidence: 0.96, source: "Organization schema", user_edited: false },
      category: { value: "crm", confidence: 0.55, source: "text classification", user_edited: false },
      aliases: { value: ["HubSpot"], confidence: 0.7, source: "domain stem", user_edited: false },
    },
    competitors_proposed: [],
    prompts_generated: [],
    prompts_free_remaining: 10,
    credits_charged: 0,
    low_confidence_fields: ["category"],
  };

  function serviceReading(rows: unknown[], entitlements: Record<string, { value: unknown }> = GENEROUS) {
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          if (sql.includes("SELECT discovery")) return { rows };
          if (sql.includes("SELECT name FROM competitors")) return { rows: [] };
          return { rows: [] };
        }),
      },
    } as never);
    return new ProjectsService(
      { enqueueTenantJob: vi.fn() } as unknown as QueueProducer,
      resolverReturning(entitlements),
      urlGuard,
    );
  }

  const stored = (extra: Record<string, unknown> = {}) => [{ discovery: DISCOVERED, category_slug: null, ...extra }];

  // AC3 — applied, NOT marked edited.
  it("scenario 3 — accepting a discovered field applies it and does not mark it edited", async () => {
    const result = await serviceReading(stored()).confirmDiscovery(WS, "p1", {
      fields: { brand_name: { decision: "accept" } },
    }, 1);

    expect(result.fields.brand_name?.value).toBe("HubSpot");
    expect(result.fields.brand_name?.user_edited).toBe(false);
    const update = calls.find((c) => c.sql.includes("UPDATE projects"))!;
    expect(update.sql).toContain("name = $2");
    expect(update.params).toContain("HubSpot");
  });

  // AC4 — applied AND marked edited. This flag is what re-discovery reads.
  it("scenario 4 — overriding a field applies the new value and marks it edited", async () => {
    const result = await serviceReading(stored()).confirmDiscovery(WS, "p1", {
      fields: { brand_name: { decision: "override", value: "HubSpot, Inc." } },
    }, 1);

    expect(result.fields.brand_name?.value).toBe("HubSpot, Inc.");
    expect(result.fields.brand_name?.user_edited).toBe(true);
    // A human's decision is certain by definition; the machine's confidence in
    // its own guess is no longer the relevant number.
    expect(result.fields.brand_name?.confidence).toBe(1);
  });

  it("writes the override to its mapped column, not to a column of the same name", async () => {
    await serviceReading(stored()).confirmDiscovery(WS, "p1", {
      fields: { category: { decision: "override", value: "marketing-automation" } },
    }, 1);

    const update = calls.find((c) => c.sql.includes("UPDATE projects"))!;
    expect(update.sql).toContain("category_slug = $2");
    expect(update.params).toContain("marketing-automation");
  });

  it("confirming a field clears it from low_confidence_fields", async () => {
    const result = await serviceReading(stored()).confirmDiscovery(WS, "p1", {
      fields: { category: { decision: "accept" } },
    }, 1);
    expect(result.low_confidence_fields).not.toContain("category");
  });

  // AC7 — idempotent.
  it("scenario 9 — confirming twice produces the same state", async () => {
    const body = { fields: { brand_name: { decision: "override" as const, value: "HubSpot, Inc." } } };
    const first = await serviceReading(stored()).confirmDiscovery(WS, "p1", body, 1);
    const second = await serviceReading([{ discovery: first, category_slug: null }]).confirmDiscovery(WS, "p1", body, 1);
    expect(second).toEqual(first);
  });

  it("refuses to accept a field nothing was discovered for, rather than silently ignoring it", async () => {
    const error = await serviceReading(stored())
      .confirmDiscovery(WS, "p1", { fields: { description: { decision: "accept" } } }, 1)
      .catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("validation_failed");
  });

  it("refuses a list value for a scalar field, and a scalar for a list field", async () => {
    const scalarGivenList = await serviceReading(stored())
      .confirmDiscovery(WS, "p1", { fields: { brand_name: { decision: "override", value: ["a", "b"] } } }, 1)
      .catch((e: unknown) => e);
    expect((scalarGivenList as DomainError).code).toBe("validation_failed");

    const listGivenScalar = await serviceReading(stored())
      .confirmDiscovery(WS, "p1", { fields: { aliases: { decision: "override", value: "one" } } }, 1)
      .catch((e: unknown) => e);
    expect((listGivenScalar as DomainError).code).toBe("validation_failed");
  });

  // AC5 — competitors up to the entitlement.
  it("scenario 6 — confirming competitors within the cap creates the tracked rows", async () => {
    await serviceReading(stored()).confirmDiscovery(WS, "p1", {
      competitors: [{ name: "Salesforce", root_domain: "salesforce.com" }, { name: "Pipedrive" }],
    }, 1);

    const inserts = calls.filter((c) => c.sql.includes("INSERT INTO competitors"));
    expect(inserts).toHaveLength(2);
    // Column and value are the real ones (`source`, CHECK ('user','auto_detected'));
    // the real-database proof is test/integration/competitor-confirm-cap.spec.ts.
    expect(inserts[0]!.sql).toMatch(/aliases, source\)\s+VALUES \(.*'user'\)/s);
    expect(inserts[0]!.sql).not.toContain("origin");
  });

  it("scenario 7 — confirming beyond the cap fails with the structural limit, naming it", async () => {
    const error = await serviceReading(stored(), { "competitors.max_per_project": { value: 1 } })
      .confirmDiscovery(WS, "p1", { competitors: [{ name: "A" }, { name: "B" }] }, 1)
      .catch((e: unknown) => e);

    expect((error as DomainError).code).toBe("entitlement_exceeded");
    expect((error as DomainError).details).toMatchObject({ key: "competitors.max_per_project", limit: 1, current: 2 });
  });

  // AC6 — the flag is a prompt, not a gate.
  it("scenario 8 — an empty confirmation is valid; nothing is required", async () => {
    const result = await serviceReading(stored()).confirmDiscovery(WS, "p1", {}, 1);
    expect(result.fields.category?.value).toBe("crm");
    expect(calls.some((c) => c.sql.includes("INSERT INTO competitors"))).toBe(false);
  });

  it("404s for a project that does not exist or is another tenant's", async () => {
    const error = await serviceReading([]).confirmDiscovery(WS, "p1", {}, 1).catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("not_found");
  });

  it("takes no workspace_id predicate — RLS scopes it (NFR-SEC-01)", async () => {
    await serviceReading(stored()).confirmDiscovery(WS, "p1", {
      fields: { brand_name: { decision: "accept" } },
    }, 1);
    for (const call of calls) {
      if (call.sql.includes("INSERT INTO")) continue; // an insert names the column it fills
      expect(call.sql).not.toContain("workspace_id");
    }
  });

  // AC9 / scenario 10 — "overriding the category triggers recomputation of
  // anything category-relative rather than leaving stale derived values".
  //
  // The trigger is built and correct; the JOB it asks for is inert.
  // rollup.metric_daily has no handler yet (STORY-124's registry lists it
  // among the unwired), so enqueueing would pile jobs into Redis for as long
  // as that stays true. The guard makes this start working the day the handler
  // lands, with no edit here.
  it("scenario 10 — a category override asks for recomputation and does not throw while the queue is inert", async () => {
    const queues = { enqueueTenantJob: vi.fn() } as unknown as QueueProducer;
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          return { rows: sql.includes("SELECT discovery") ? [{ discovery: DISCOVERED, category_slug: "crm" }] : [] };
        }),
      },
    } as never);
    const service = new ProjectsService(queues, resolverReturning(GENEROUS), urlGuard);

    await expect(
      service.confirmDiscovery(WS, "p1", { fields: { category: { decision: "override", value: "cdp" } } }, 1),
    ).resolves.toBeDefined();

    // Nothing enqueued, because nothing would consume it.
    expect(queues.enqueueTenantJob).not.toHaveBeenCalled();
  });

  it("a NON-category override never asks for recomputation", async () => {
    const queues = { enqueueTenantJob: vi.fn() } as unknown as QueueProducer;
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          return { rows: sql.includes("SELECT discovery") ? [{ discovery: DISCOVERED, category_slug: "crm" }] : [] };
        }),
      },
    } as never);
    const service = new ProjectsService(queues, resolverReturning(GENEROUS), urlGuard);

    await service.confirmDiscovery(WS, "p1", { fields: { brand_name: { decision: "override", value: "X" } } }, 1);
    expect(queues.enqueueTenantJob).not.toHaveBeenCalled();
  });

  it("re-confirming the SAME category is not a change and asks for nothing", async () => {
    const queues = { enqueueTenantJob: vi.fn() } as unknown as QueueProducer;
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          return { rows: sql.includes("SELECT discovery") ? [{ discovery: DISCOVERED, category_slug: "crm" }] : [] };
        }),
      },
    } as never);
    const service = new ProjectsService(queues, resolverReturning(GENEROUS), urlGuard);

    await service.confirmDiscovery(WS, "p1", { fields: { category: { decision: "accept" } } }, 1);
    expect(queues.enqueueTenantJob).not.toHaveBeenCalled();
  });
});

// STORY-132 — the workspace matrix read. Specified in api-specification.md §3,
// referenced by STORY-089's central AC, and owned by no story until this one.
describe("STORY-132 · ProjectsService.list", () => {
  let calls: Recorded[];

  function serviceReading(rows: unknown[]) {
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          return { rows };
        }),
      },
    } as never);
    return new ProjectsService(
      { enqueueTenantJob: vi.fn() } as unknown as QueueProducer,
      resolverReturning(GENEROUS),
      urlGuard,
    );
  }

  function row(over: Record<string, unknown> = {}) {
    return {
      id: "0195e5b7-0000-7000-8000-000000000001",
      name: "HubSpot",
      slug: "hubspot.com",
      root_domain: "hubspot.com",
      kind: "brand",
      status: "active",
      discovery_status: "completed",
      prompts_active: 0,
      prompts_cap: 40,
      open_task_count: 0,
      open_tasks_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
      domain_verified_at: null,
      created_at: new Date("2026-09-01T00:00:00Z"),
      visibility_blended: null,
      visibility_delta_30d: null,
      rendering_quality: null,
      rendering_delta_30d: null,
      source_coverage: null,
      aux_score_current: null,
      sentiment_score: null,
      sentiment_delta_30d: null,
      cells_30d: null,
      visibility_by_engine: null,
      sparkline_30d: null,
      demo_seeded_at: null,
      created_at_key: "2026-09-01 00:00:00+00",
      ...over,
    };
  }

  it("scenario 1 — returns the workspace's projects", async () => {
    const page = await serviceReading([row(), row({ id: "0195e5b7-0000-7000-8000-000000000002", name: "Stripe" })]).list({
      limit: 50,
    } as never);

    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.name).toBe("HubSpot");
  });

  it("scenario 2 — an empty workspace is an empty array, not an error", async () => {
    await expect(serviceReading([]).list({ limit: 50 } as never)).resolves.toMatchObject({ items: [] });
  });

  it("scenario 3 — excludes soft-deleted projects", async () => {
    await serviceReading([]).list({ limit: 50 } as never);
    expect(calls[0]!.sql).toContain("deleted_at IS NULL");
  });

  // NFR-SEC-01 — the tenant boundary lives in the policy, not in this SQL.
  it("scenario 4 — takes no workspace_id predicate; RLS scopes the tenant", async () => {
    await serviceReading([]).list({ limit: 50 } as never);
    expect(calls[0]!.sql).not.toContain("workspace_id");
  });

  // THE SECURITY-RELEVANT ONE. For nominara_app the only policy on `projects`
  // is the workspace one — portal_scope_projects binds nominara_portal alone —
  // so an analyst restricted to two of five projects is NOT restricted by RLS
  // here. A client-side filter over a wider payload would leak the existence
  // of projects the caller may not know about.
  it("scenario 5 — the QUERY applies the project scope, not the caller", async () => {
    await serviceReading([]).list({ limit: 50 } as never);
    expect(calls[0]!.sql).toContain("app.current_scope_projects()");
    expect(calls[0]!.sql).toContain("id = ANY(app.current_scope_projects())");
  });

  it("scenario 6 — an empty scope array means unscoped, not nothing", async () => {
    await serviceReading([]).list({ limit: 50 } as never);
    // Safe only because tenant-context sets the GUC exclusively for a member
    // whose scope is non-empty; the expression reads fail-open at a glance.
    expect(calls[0]!.sql).toContain("cardinality(app.current_scope_projects()) = 0");
  });

  // Absence is not zero. A project with no rollup has NO score.
  it("scenario 7 — score fields are null before any rollup, never 0", async () => {
    const page = await serviceReading([row()]).list({ limit: 50 } as never);

    expect(page.items[0]!.visibility_blended).toBeNull();
    expect(page.items[0]!.visibility_delta_30d).toBeNull();
    expect(page.items[0]!.rendering_quality).toBeNull();
    expect(page.items[0]!.rendering_delta_30d).toBeNull();
    expect(page.items[0]!.source_coverage).toBeNull();
    expect(page.items[0]!.aux_score_current).toBeNull();
    expect(page.items[0]!.sentiment_score).toBeNull();
    expect(page.items[0]!.sentiment_delta_30d).toBeNull();
    expect(page.items[0]!.sentiment_band).toBeNull();
    expect(page.items[0]!.confidence).toBeNull();
    expect(page.items[0]!.engine_scores).toBeNull();
    expect(page.items[0]!.sparkline_30d).toBeNull();
  });

  // pg returns `numeric` as a STRING — it refuses to narrow, because a numeric
  // can exceed what a double represents exactly. Unparsed it reaches the wire
  // as "88.200" and the response schema rejects it.
  it("parses a numeric score from pg's string form", async () => {
    const page = await serviceReading([row({ visibility_blended: "88.200", aux_score_current: "74.500" })]).list({
      limit: 50,
    } as never);

    expect(page.items[0]!.visibility_blended).toBe(88.2);
    expect(page.items[0]!.aux_score_current).toBe(74.5);
  });

  // STORY-169 — the fields computed at READ time rather than stored.
  describe("STORY-169 · read-time fields", () => {
    it("derives sentiment_band from sentiment_score, and stays null when the score is null", async () => {
      const positive = await serviceReading([row({ sentiment_score: "82.000" })]).list({ limit: 50 } as never);
      expect(positive.items[0]!.sentiment_band).toBe("positive");

      const absent = await serviceReading([row()]).list({ limit: 50 } as never);
      expect(absent.items[0]!.sentiment_band).toBeNull();
    });

    it("derives confidence from cells_30d, and stays null when cells_30d is null — not the same as 'low'", async () => {
      const low = await serviceReading([row({ cells_30d: 5 })]).list({ limit: 50 } as never);
      expect(low.items[0]!.confidence).toBe("low");

      const high = await serviceReading([row({ cells_30d: 150 })]).list({ limit: 50 } as never);
      expect(high.items[0]!.confidence).toBe("high");

      const unmeasured = await serviceReading([row({ cells_30d: null })]).list({ limit: 50 } as never);
      expect(unmeasured.items[0]!.confidence).toBeNull();
    });

    it("turns visibility_by_engine into an array sorted by score descending", async () => {
      const page = await serviceReading([
        row({
          visibility_by_engine: {
            chatgpt: { score: 40, delta_30d: null },
            google_ai_mode: { score: 71.5, delta_30d: 3.2 },
          },
        }),
      ]).list({ limit: 50 } as never);

      expect(page.items[0]!.engine_scores).toEqual([
        { engine_key: "google_ai_mode", score: 71.5, delta_30d: 3.2 },
        { engine_key: "chatgpt", score: 40, delta_30d: null },
      ]);
    });

    it("passes open_tasks_by_severity through unchanged", async () => {
      const page = await serviceReading([row({ open_tasks_by_severity: { critical: 2, high: 1, medium: 0, low: 3 } })]).list({
        limit: 50,
      } as never);
      expect(page.items[0]!.open_tasks_by_severity).toEqual({ critical: 2, high: 1, medium: 0, low: 3 });
    });

    // STORY-169 review — `open_tasks_by_severity`/`visibility_by_engine` are
    // jsonb columns, and coding-standards.md requires a zod schema for
    // every one, checked at read time — not a hand-written TypeScript
    // interface with no runtime check. These two prove the schemas are
    // actually WIRED IN, by feeding shapes each schema's own `.strict()`/
    // member types reject, rather than merely existing unused.
    it("throws rather than passing through an open_tasks_by_severity object with an unknown key", async () => {
      await expect(
        serviceReading([row({ open_tasks_by_severity: { critical: 0, high: 0, medium: 0, low: 0, extra: 1 } })]).list({
          limit: 50,
        } as never),
      ).rejects.toThrow();
    });

    it("throws rather than passing through a visibility_by_engine entry missing delta_30d", async () => {
      await expect(
        serviceReading([row({ visibility_by_engine: { chatgpt: { score: 40 } } })]).list({ limit: 50 } as never),
      ).rejects.toThrow();
    });

    it("demo_seeded is true only when demo_seeded_at is set", async () => {
      const real = await serviceReading([row()]).list({ limit: 50 } as never);
      expect(real.items[0]!.demo_seeded).toBe(false);

      const demo = await serviceReading([row({ demo_seeded_at: new Date("2026-09-01T00:00:00Z") })]).list({ limit: 50 } as never);
      expect(demo.items[0]!.demo_seeded).toBe(true);
    });
  });

  it("scenario 8 — orders stably and asks for one more than the limit, so has_more is knowable", async () => {
    await serviceReading([]).list({ limit: 2 } as never);

    expect(calls[0]!.sql).toContain("ORDER BY created_at ASC, id ASC");
    // limit + 1: the extra row is how a cursor page knows there is a next one
    // without a second count query.
    expect(calls[0]!.params).toContain(3);
  });

  it("serialises timestamps as ISO strings, and a null verification stays null", async () => {
    const page = await serviceReading([row({ domain_verified_at: new Date("2026-09-02T10:00:00Z") })]).list({
      limit: 50,
    } as never);

    expect(page.items[0]!.domain_verified_at).toBe("2026-09-02T10:00:00.000Z");
    expect(page.items[0]!.created_at).toBe("2026-09-01T00:00:00.000Z");
  });
});

// STORY-043 review (round 1), finding 2 — a URL-only project's first pass has no brand, category or verticals to fill templates
// from. The top-up is the confirm step: once those are confirmed, the free allowance is generated from them.
describe("STORY-043 · confirmDiscovery tops up the free prompt allowance from the confirmed context", () => {
  const FIRST_PASS = {
    discovery_status: "completed",
    duration_ms: 1200,
    fields: { brand_name: { value: "HubSpot", confidence: 0.96, source: "Organization schema", user_edited: false } },
    competitors_proposed: [],
    prompts_generated: [] as unknown[],
    prompts_free_remaining: 10,
    credits_charged: 0,
    low_confidence_fields: [],
  };

  function service(opts: { manual?: boolean; payload?: Record<string, unknown> } = {}) {
    const calls: Recorded[] = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          if (sql.includes("SELECT discovery")) return { rows: [{ discovery: opts.payload ?? FIRST_PASS, category_slug: null }] };
          if (sql.includes("FOR NO KEY UPDATE")) {
            return { rows: [{ name: "HubSpot", root_domain: "hubspot.com", category_slug: "crm", verticals: ["saas"], locale: null }] };
          }
          if (sql.includes("generation_source = 'manual'")) return { rows: opts.manual === true ? [{ one: 1 }] : [] };
          return { rows: [] };
        }),
      },
    } as never);
    const svc = new ProjectsService({ enqueueTenantJob: vi.fn() } as unknown as QueueProducer, resolverReturning(GENEROUS), urlGuard);
    return { svc, calls };
  }

  it("generates the allowance AFTER the confirmed name/category are written, and records it in the payload", async () => {
    const { svc, calls } = service();
    const result = await svc.confirmDiscovery(WS, "p1", { fields: { category: { decision: "override", value: "crm" } } }, 1);

    const applied = calls.findIndex((c) => c.sql.includes("UPDATE projects SET category_slug"));
    const firstInsert = calls.findIndex((c) => c.sql.includes("INSERT INTO tracked_prompts"));
    expect(applied).toBeGreaterThanOrEqual(0);
    expect(firstInsert).toBeGreaterThan(applied);
    expect(result.prompts_generated).toHaveLength(10);
    expect(result.prompts_free_remaining).toBe(0);
    const persisted = JSON.parse(calls.filter((c) => c.sql.includes("UPDATE projects")).at(-1)!.params.find((p) => typeof p === "string" && p.startsWith("{")) as string) as {
      prompts_generated: unknown[];
    };
    expect(persisted.prompts_generated).toHaveLength(10);
  });

  it("does nothing when what was confirmed cannot change a prompt (a description, an alias)", async () => {
    const { svc, calls } = service();
    await svc.confirmDiscovery(WS, "p1", { fields: { description: { decision: "override", value: "A CRM." } } }, 1);
    expect(calls.some((c) => c.sql.includes("INSERT INTO tracked_prompts"))).toBe(false);
  });

  it("leaves a project alone whose caller supplied prompts at creation (nothing generated, manual prompts held)", async () => {
    const { svc, calls } = service({ manual: true });
    const result = await svc.confirmDiscovery(WS, "p1", { fields: { category: { decision: "override", value: "crm" } } }, 1);
    expect(calls.some((c) => c.sql.includes("INSERT INTO tracked_prompts"))).toBe(false);
    expect(result.prompts_free_remaining).toBe(10);
  });
});
