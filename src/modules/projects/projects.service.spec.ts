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

  it("treats a null (unlimited) cap as unlimited rather than zero", async () => {
    const svc = new ProjectsService(queues, resolverReturning({ "prompts.max_per_project": { value: null } }), urlGuard);
    await expect(
      svc.create(WS, ACTOR, { root_url: "https://hubspot.com", prompts: [{ text: "a" }] }, 1),
    ).resolves.toBeDefined();
  });
});
