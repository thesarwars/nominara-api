import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsService } from "./projects.service.js";
import { DomainError } from "../../api/errors/domain-errors.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import type { QueueProducer } from "../../lib/queue/queue-producer.js";
import type { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { GuardedFetchRefusal } from "../../lib/net/guarded-fetch.js";
import { isGloballyReachable } from "../../lib/net/address-rules.js";
import { toRegistrableDomain } from "../../lib/net/registrable-domain.js";
import type { UrlGuard } from "../../lib/net/url-guard.service.js";

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
      return { rows };
    }),
  };
}

function resolverReturning(entitlements: Record<string, { value: unknown }>): EntitlementResolver {
  return {
    resolveForWorkspace: vi.fn(async () => ({ entitlements })),
    resolve: vi.fn(async () => ({ entitlements })),
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
  it("scenario 8 — supplied competitors are user_authored and prompts manual", async () => {
    await service().create(
      WS,
      ACTOR,
      { root_url: "https://hubspot.com", competitors: [{ name: "Salesforce" }], prompts: [{ text: "best crm" }] },
      1,
    );

    expect(calls.some((c) => c.sql.includes("INSERT INTO competitors") && c.sql.includes("user_authored"))).toBe(true);
    expect(calls.some((c) => c.sql.includes("INSERT INTO tracked_prompts") && c.sql.includes("'manual'"))).toBe(true);
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
    expect(inserts[0]!.sql).toContain("user_authored");
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
