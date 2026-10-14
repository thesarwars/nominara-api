import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainError } from "../../api/errors/domain-errors.js";
import type { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { PromptActivationService } from "./activation.service.js";

// STORY-046 — activation against the cap.
// plans-and-entitlements.md §10, api-specification.md §3.
//
// The unit-level half: the scenarios about REFUSAL, ARITHMETIC and ORDER,
// all decidable from what the service queries and in what sequence. The ones
// needing real RLS, real concurrency and the real partial index are
// integration.

interface Recorded {
  readonly sql: string;
  readonly params: unknown[];
}

const WS = "11111111-1111-7111-8111-111111111111";
const PROJECT = "33333333-3333-7333-8333-333333333333";
const P1 = "01a06ccd-0000-7000-8000-000000000001";
const P2 = "01a06ccd-0000-7000-8000-000000000002";
const P3 = "01a06ccd-0000-7000-8000-000000000003";

/**
 * A client that answers each statement by matching its SQL.
 *
 * Keyed on a fragment rather than call order: the service's query sequence is
 * an implementation detail, and a positional stub would break on any
 * reordering while telling us nothing about correctness.
 */
function clientAnsweringWith(calls: Recorded[], answers: { match: string; rows: unknown[] }[]) {
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const answer = answers.find((candidate) => sql.includes(candidate.match));
      return { rows: answer?.rows ?? [] };
    }),
  };
}

function resolverReturning(limit: number | string): EntitlementResolver {
  return {
    resolveForWorkspace: vi.fn(async () => ({ entitlements: { "prompts.max_per_project": { value: limit } } })),
    resolve: vi.fn(async () => ({ entitlements: { "prompts.max_per_project": { value: limit } } })),
  } as unknown as EntitlementResolver;
}

/** `archived` rows are the activatable ones; `active` rows are already on. */
function promptRows(rows: { id: string; status: string }[]) {
  return rows.map((row) => ({ id: row.id, status: row.status, project_id: PROJECT }));
}

interface Scenario {
  readonly cap?: number;
  readonly activeCount?: number;
  readonly generatedCount?: number;
  readonly prompts?: { id: string; status: string }[];
}

describe("STORY-046 · PromptActivationService.activate", () => {
  let calls: Recorded[];

  function setup(scenario: Scenario = {}) {
    calls = [];
    const client = clientAnsweringWith(calls, [
      { match: "FROM projects", rows: [{ prompts_cap: scenario.cap ?? 40 }] },
      { match: "app.prompt_slot_usage", rows: [{ n: scenario.activeCount ?? 0 }] },
      { match: "status <> 'archived'", rows: [{ n: scenario.activeCount ?? 0 }] },
      { match: "generation_source = 'generated'", rows: [{ generated: scenario.generatedCount ?? 15, activated: scenario.activeCount ?? 0 }] },
      { match: "WHERE id = ANY", rows: promptRows(scenario.prompts ?? [{ id: P1, status: "archived" }]) },
    ]);
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client, context: { workspaceId: WS } } as never);
    return new PromptActivationService(resolverReturning(scenario.cap ?? 40));
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Scenario 2 — the happy path.
  // ---------------------------------------------------------------------------

  it("scenario 2 — activates the subset and reports the new active count", async () => {
    const service = setup({ activeCount: 32, prompts: [{ id: P1, status: "archived" }, { id: P2, status: "archived" }] });

    const result = await service.activate(PROJECT, { prompt_ids: [P1, P2] });

    expect(result.activated_prompt_ids).toEqual([P1, P2]);
    expect(result.summary).toEqual({ requested: 2, activated: 2, already_active: 0, slots_remaining: 6 });
    expect(result.prompts_active).toBe(34);
    expect(result.prompts_cap).toBe(40);
  });

  // ⚠ STORY-150 review — A BODY UUID, WHICH NO GUARD CANONICALISES.
  //
  // `prompt_ids` arrives in the body, so `CanonicalParamsGuard` never sees it,
  // and zod's `.uuid()` accepts an uppercase one. Postgres then matched the
  // row anyway (`$1::uuid[]` casts), so the row came BACK from `loadPrompts`
  // — keyed lowercase, as the column stores it — while `found.get(UPPERCASE)`
  // missed it. The caller was told "no such prompt in this project" about a
  // prompt in their own project. The stub below answers with the LOWERCASE id
  // precisely because that is what the database returns.
  it("STORY-150 — an uppercase prompt id names the same prompt, not a missing one", async () => {
    const service = setup({ activeCount: 32, prompts: [{ id: P1, status: "archived" }] });

    const result = await service.activate(PROJECT, { prompt_ids: [P1.toUpperCase()] });

    expect(result.activated_prompt_ids).toEqual([P1]);
    expect(result.summary.activated).toBe(1);
  });

  it("STORY-150 — one prompt sent twice in two cases is a duplicate, and is named as one", async () => {
    // It failed closed before — at loadPrompts, as "no such prompt" — so the
    // refusal was right for the wrong reason and said the wrong thing.
    const service = setup({ activeCount: 32, prompts: [{ id: P1, status: "archived" }] });

    const error = await service
      .activate(PROJECT, { prompt_ids: [P1, P1.toUpperCase()] })
      .catch((e: unknown) => e as DomainError);

    expect(error).toBeInstanceOf(Error);
    expect((error as DomainError).code).toBe("validation_failed");
    expect(String((error as DomainError).message)).toContain("duplicate");
  });

  it("scenario 10 — the active count is written in the SAME statement sequence, not deferred", async () => {
    // AC10: "maintained in the same transaction as any activation or
    // archival, so it can never drift". The ambient tenant transaction is
    // the transaction; what this asserts is that the count update is one of
    // the queries this call makes rather than an afterCommit or a later job.
    const service = setup({ activeCount: 32 });
    await service.activate(PROJECT, { prompt_ids: [P1] });

    const updates = calls.filter((call) => call.sql.includes("UPDATE projects"));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toContain("prompts_active");
  });

  it("updates the prompts to active in one statement, not one per id", async () => {
    // Fifteen round trips inside a transaction to set fifteen rows to the
    // same value, on the request path, for no benefit.
    const service = setup({ prompts: [{ id: P1, status: "archived" }, { id: P2, status: "archived" }, { id: P3, status: "archived" }] });
    await service.activate(PROJECT, { prompt_ids: [P1, P2, P3] });

    const updates = calls.filter((call) => call.sql.includes("UPDATE tracked_prompts"));
    expect(updates).toHaveLength(1);
  });

  it("charges nothing, and touches no wallet or ledger", async () => {
    // AC3 is blocked (CreditGuard is a no-op, reserve/commit is EPIC-10) and
    // the contract types `credits_charged` as the literal 0. The assertion
    // that matters is the ABSENCE of any credit statement, which is what
    // makes "charges nothing" true by construction.
    const service = setup();
    const result = await service.activate(PROJECT, { prompt_ids: [P1] });

    expect(result.credits_charged).toBe(0);
    const touched = calls.map((call) => call.sql).join(" ").toLowerCase();
    for (const table of ["wallet", "credit_ledger", "ledger_entries", "debit", "reserve"]) {
      expect(touched, `activation must not touch ${table}`).not.toContain(table);
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 4 — at the cap.
  // ---------------------------------------------------------------------------

  it("scenario 4 — refuses with entitlement_exceeded naming the remaining slots", async () => {
    // §3: "403 entitlement_exceeded names the remaining slots." The details
    // shape is `{key, limit, current}`, so remaining is derivable — and
    // `current` is the count BEFORE this call, which is what the customer
    // sees in the dialog.
    const service = setup({ cap: 40, activeCount: 39, prompts: [{ id: P1, status: "archived" }, { id: P2, status: "archived" }] });

    const error = await service.activate(PROJECT, { prompt_ids: [P1, P2] }).catch((e: unknown) => e as DomainError);

    expect(error).toBeInstanceOf(Error);
    expect((error as DomainError).code).toBe("entitlement_exceeded");
    expect((error as DomainError).details).toEqual({ key: "prompts.max_per_project", limit: 40, current: 39 });
  });

  it("carries the `increase_limit` remediation, which is what offers §10's paths", async () => {
    // §10's dialog offers "Free up slots", "Add a project", "Upgrade".
    // Freeing slots needs no server hint — it is archiving something the
    // customer can already see. The other two are the remediation, and §2
    // commits to exactly ONE, so this is it rather than an invented array.
    const service = setup({ cap: 40, activeCount: 40 });
    const error = await service.activate(PROJECT, { prompt_ids: [P1] }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).remediation?.kind).toBe("increase_limit");
  });

  it("refuses ALL OR NOTHING — never activates the part that fits", async () => {
    // The refusal has to happen before any UPDATE, or a caller who asked for
    // ten with eight slots gets eight they did not choose.
    const service = setup({ cap: 40, activeCount: 39, prompts: [{ id: P1, status: "archived" }, { id: P2, status: "archived" }] });
    await service.activate(PROJECT, { prompt_ids: [P1, P2] }).catch(() => undefined);
    // A WRITE is a statement that BEGINS with a write verb. This used to be
    // `includes("UPDATE")`, which a `SELECT ... FOR UPDATE` (the project lock the
    // activation charge needs, AC3) also matches although it writes nothing.
    // INSERT and DELETE are added, so the assertion is stricter, not looser.
    expect(calls.filter((call) => /^\s*(UPDATE|INSERT|DELETE)\b/i.test(call.sql))).toHaveLength(0);
  });

  it("allows a request that exactly fills the last slots", async () => {
    const service = setup({ cap: 40, activeCount: 38, prompts: [{ id: P1, status: "archived" }, { id: P2, status: "archived" }] });
    const result = await service.activate(PROJECT, { prompt_ids: [P1, P2] });
    expect(result.summary.slots_remaining).toBe(0);
  });

  it("refuses when the cap was already exceeded by a downgrade", async () => {
    // `current` legitimately exceeds `limit` after a plan downgrade — the
    // details schema's own comment says so. Activation must refuse rather
    // than compute a negative remaining and let anything through.
    const service = setup({ cap: 10, activeCount: 25 });
    const error = await service.activate(PROJECT, { prompt_ids: [P1] }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("entitlement_exceeded");
    expect((error as DomainError).details).toEqual({ key: "prompts.max_per_project", limit: 10, current: 25 });
  });

  // ---------------------------------------------------------------------------
  // Scenarios 5, 13 — free re-activation, and replay.
  // ---------------------------------------------------------------------------

  it("scenario 13 — replaying an activation is idempotent and observable", async () => {
    // AC12. Every requested prompt is already active, so nothing is
    // activated and nothing is refused — and the summary says which happened.
    const service = setup({ activeCount: 34, prompts: [{ id: P1, status: "active" }, { id: P2, status: "active" }] });

    const result = await service.activate(PROJECT, { prompt_ids: [P1, P2] });

    expect(result.summary).toEqual({ requested: 2, activated: 0, already_active: 2, slots_remaining: 6 });
    expect(result.activated_prompt_ids).toEqual([]);
    expect(calls.filter((call) => call.sql.includes("UPDATE tracked_prompts"))).toHaveLength(0);
  });

  it("counts an already-active prompt against neither the cap nor the charge", async () => {
    // A replay at the cap must SUCCEED. Counting the already-active ones as
    // newly activated would make the retry of a successful call fail with a
    // 403, which is the worst possible behaviour for an idempotent endpoint.
    const service = setup({ cap: 40, activeCount: 40, prompts: [{ id: P1, status: "active" }] });
    const result = await service.activate(PROJECT, { prompt_ids: [P1] });
    expect(result.summary.already_active).toBe(1);
  });

  it("scenario 5 — activating an archived candidate later is free", async () => {
    // FR-CRD-06. Free today because nothing charges at all; the literal 0 in
    // the contract is what forces this to be revisited when EPIC-10 lands
    // and §4 versus FR-CRD-06 is settled.
    const service = setup({ activeCount: 5, prompts: [{ id: P1, status: "archived" }] });
    const result = await service.activate(PROJECT, { prompt_ids: [P1] });
    expect(result.credits_charged).toBe(0);
    expect(result.summary.activated).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Scenario 7 — the coverage indicator.
  // ---------------------------------------------------------------------------

  it("scenario 7 — reports activated over generated, never a full-looking ratio", async () => {
    // FR-CRD-08. A capped project that generated 15 and activated 8 reports
    // 8/15, so it cannot render as full coverage.
    const service = setup({ activeCount: 7, generatedCount: 15, prompts: [{ id: P1, status: "archived" }] });
    const result = await service.activate(PROJECT, { prompt_ids: [P1] });
    expect(result.coverage.generated).toBe(15);
    expect(result.coverage.activated).toBeLessThan(result.coverage.generated);
  });

  // ---------------------------------------------------------------------------
  // Refusals about the ids themselves.
  // ---------------------------------------------------------------------------

  it("names the ids it could not find rather than failing opaquely", async () => {
    const service = setup({ prompts: [{ id: P1, status: "archived" }] });
    const error = await service.activate(PROJECT, { prompt_ids: [P1, P2] }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("validation_failed");
    expect(JSON.stringify((error as DomainError).details)).toContain(P2);
  });

  it("refuses a prompt belonging to another project", async () => {
    // RLS scopes the tenant; it does not scope the PROJECT, and the route's
    // path names one. A prompt id from a sibling project in the same
    // workspace would otherwise be activated against the wrong project's cap.
    const service = setup();
    const client = clientAnsweringWith(calls, [
      { match: "FROM projects", rows: [{ prompts_cap: 40 }] },
      { match: "generation_source = 'generated'", rows: [{ generated: 15, activated: 0 }] },
      { match: "status <> 'archived'", rows: [{ n: 0 }] },
      { match: "WHERE id = ANY", rows: [{ id: P1, status: "archived", project_id: "44444444-4444-7444-8444-444444444444" }] },
    ]);
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client, context: { workspaceId: WS } } as never);

    const error = await service.activate(PROJECT, { prompt_ids: [P1] }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("validation_failed");
  });

  it("refuses a duplicate id in the request rather than double-counting it", async () => {
    // `[P1, P1]` with one slot left would otherwise pass the cap check as
    // two and activate one, or pass as one and be reported as two.
    const service = setup({ prompts: [{ id: P1, status: "archived" }] });
    const error = await service.activate(PROJECT, { prompt_ids: [P1, P1] }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("validation_failed");
  });

  it("refuses when the project does not exist", async () => {
    calls = [];
    const client = clientAnsweringWith(calls, []);
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client, context: { workspaceId: WS } } as never);
    const service = new PromptActivationService(resolverReturning(40));
    const error = await service.activate(PROJECT, { prompt_ids: [P1] }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("not_found");
  });
});
