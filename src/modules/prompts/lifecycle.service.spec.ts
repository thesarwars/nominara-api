import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainError } from "../../api/errors/domain-errors.js";
import type { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { ProjectOutOfScopeException } from "../../tenancy/errors.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { PromptLifecycleService } from "./lifecycle.service.js";

// STORY-046 — `PATCH /v1/prompts/{id}`: pause/resume, the priority flag, and
// the edit path. api-specification.md §3.
//
// THE EDIT PATH IS THE INTERESTING ONE. `FR-FAN-01f`: "Editing a prompt's
// text creates a new `text_hash` and starts a NEW HISTORY SERIES, with the
// previous series preserved and visibly marked `superseded`. Metric
// continuity is never faked across a wording change." The story calls it a
// measurement-integrity requirement: "Carrying history across a wording
// change would silently compare answers to two different questions, and the
// resulting trend would be meaningless while looking perfectly normal."

interface Recorded {
  readonly sql: string;
  readonly params: unknown[];
}

const WS = "11111111-1111-7111-8111-111111111111";
const PROJECT = "33333333-3333-7333-8333-333333333333";
const PROMPT = "01a06ccd-0000-7000-8000-000000000001";

function clientAnsweringWith(calls: Recorded[], answers: { match: string; rows: unknown[] }[], failOn?: { match: string; error: Error }) {
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (failOn !== undefined && sql.includes(failOn.match)) throw failOn.error;
      const answer = answers.find((candidate) => sql.includes(candidate.match));
      return { rows: answer?.rows ?? [] };
    }),
  };
}

function resolverReturning(entitlements: Record<string, { value: unknown }>): EntitlementResolver {
  return { resolveForWorkspace: vi.fn(async () => ({ entitlements })) } as unknown as EntitlementResolver;
}

const GENEROUS = { "prompts.max_per_project": { value: 40 }, "scan.priority_subset_size": { value: 50 } };

interface Scenario {
  readonly status?: string;
  readonly isPriority?: boolean;
  readonly activeCount?: number;
  readonly priorityCount?: number;
  readonly entitlements?: Record<string, { value: unknown }>;
  readonly failOn?: { match: string; error: Error };
  readonly missing?: boolean;
  /** The member's project scope covers the prompt's project. Default true (unrestricted). */
  readonly inScope?: boolean;
}

describe("STORY-046 · PromptLifecycleService.update", () => {
  let calls: Recorded[];

  function setup(scenario: Scenario = {}) {
    calls = [];
    const client = clientAnsweringWith(
      calls,
      [
        {
          match: "FROM tracked_prompts p",
          rows: scenario.missing === true
            ? []
            : [
                {
                  id: PROMPT,
                  project_id: PROJECT,
                  workspace_id: WS,
                  status: scenario.status ?? "active",
                  is_priority: scenario.isPriority ?? false,
                  text: "Which crm do you recommend for mid market teams?",
                  intent_archetype: "recommendation",
                  funnel_stage: "consideration",
                  generation_source: "generated",
                  generation_batch_id: null,
                  generator_meta: { template_id: "recommendation.a1" },
                },
              ],
        },
        { match: "current_scope_projects", rows: [{ in_scope: scenario.inScope ?? true }] },
        { match: "count(*) FILTER (WHERE is_priority", rows: [{ n: scenario.priorityCount ?? 0 }] },
        { match: "status <> 'archived'", rows: [{ n: scenario.activeCount ?? 10 }] },
        { match: "prompts_cap", rows: [{ prompts_active: scenario.activeCount ?? 10, prompts_cap: 40 }] },
      ],
      scenario.failOn,
    );
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client, context: { workspaceId: WS } } as never);
    return new PromptLifecycleService(resolverReturning(scenario.entitlements ?? GENEROUS));
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // STORY-019 review - the id names a prompt, so the member's project scope is checked against the row's own
  // project BEFORE anything is read or written; a denial is 403 project_out_of_scope, never 404.
  it("REQ-019-scope-out: refuses a prompt outside the member's project scope and writes nothing", async () => {
    await expect(setup({ inScope: false }).update(PROMPT, { status: "paused" })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    expect(calls.some((call) => /UPDATE|INSERT/.test(call.sql))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Scenarios 9 and 10 — pause frees nothing, archive frees a slot.
  // ---------------------------------------------------------------------------

  it("scenario 9 — pausing stops capture and frees NO slot", async () => {
    const result = await setup({ status: "active" }).update(PROMPT, { status: "paused" });
    expect(result.status).toBe("paused");
    // `PROMPT_OCCUPIES_SLOT` is `status <> 'archived'`, so a paused prompt
    // still occupies. The story's reason: "a paused prompt still occupies
    // configuration and can be resumed, so treating it as free capacity
    // would let a customer exceed their cap by pausing and adding."
    const update = calls.find((call) => call.sql.includes("UPDATE tracked_prompts"));
    expect(update?.params).toContain("paused");
  });

  it("scenario 10 — archiving frees a slot", async () => {
    const result = await setup({ status: "active", activeCount: 10 }).update(PROMPT, { status: "archived" });
    expect(result.status).toBe("archived");
    // The count is recomputed in the same statement sequence, so the freed
    // slot is visible immediately rather than at the next read.
    expect(calls.some((call) => call.sql.includes("UPDATE projects") && call.sql.includes("prompts_active"))).toBe(true);
  });

  it("resuming a paused prompt consumes no NEW slot — it never released one", async () => {
    const service = setup({ status: "paused", activeCount: 40, entitlements: { ...GENEROUS, "prompts.max_per_project": { value: 40 } } });
    // At the cap, and this must still succeed: paused already occupies, so
    // resuming changes nothing about occupancy.
    await expect(service.update(PROMPT, { status: "active" })).resolves.toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // The cap, on the OTHER path into activation.
  // ---------------------------------------------------------------------------

  it("BINDS THE CAP when un-archiving, or the activate endpoint's limit is bypassable", async () => {
    // The hole this closes: without it a customer at their cap can PATCH
    // archived prompts to active one at a time and never meet the cap check
    // that `POST .../activate` enforces. Any transition OUT of `archived` is
    // an activation.
    const service = setup({ status: "archived", activeCount: 40 });
    const error = await service.update(PROMPT, { status: "active" }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("entitlement_exceeded");
    expect((error as DomainError).details).toEqual({ key: "prompts.max_per_project", limit: 40, current: 40 });
  });

  it("binds the cap on archived -> PAUSED too, because paused occupies a slot", async () => {
    // The subtle half. Paused is not archived, so it occupies — un-archiving
    // straight to paused takes a slot just as surely as going to active.
    const service = setup({ status: "archived", activeCount: 40 });
    const error = await service.update(PROMPT, { status: "paused" }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("entitlement_exceeded");
  });

  it("does not touch the cap for a status change between two occupying states", async () => {
    const service = setup({ status: "active", activeCount: 40 });
    await expect(service.update(PROMPT, { status: "paused" })).resolves.toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // AC11 — the priority flag, bounded by the plan's subset size.
  // ---------------------------------------------------------------------------

  it("sets the priority flag", async () => {
    const result = await setup({ priorityCount: 3 }).update(PROMPT, { is_priority: true });
    expect(result.is_priority).toBe(true);
  });

  it("refuses a priority flag beyond the plan's subset size", async () => {
    const service = setup({ priorityCount: 50, entitlements: { ...GENEROUS, "scan.priority_subset_size": { value: 50 } } });
    const error = await service.update(PROMPT, { is_priority: true }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("entitlement_exceeded");
    expect((error as DomainError).details).toMatchObject({ key: "scan.priority_subset_size", limit: 50 });
  });

  it("always allows CLEARING the flag, even past the limit", async () => {
    // Otherwise a project that ended up over the limit — a downgrade — could
    // not be brought back under it, which is the one action that fixes it.
    const service = setup({ isPriority: true, priorityCount: 80 });
    await expect(service.update(PROMPT, { is_priority: false })).resolves.toBeDefined();
  });

  it("does not re-count when the flag is already set", async () => {
    // Setting `is_priority: true` on a prompt that already has it is a no-op
    // and must not be refused at the limit — the same idempotency argument
    // as a replayed activation.
    const service = setup({ isPriority: true, priorityCount: 50 });
    await expect(service.update(PROMPT, { is_priority: true })).resolves.toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Scenario 11 — the edit path. FR-FAN-01f.
  // ---------------------------------------------------------------------------

  it("scenario 11 — editing the text creates a NEW row and supersedes the old", async () => {
    const result = await setup({ status: "active" }).update(PROMPT, { text: "which crm is best for a mid-market sales team?" });

    // The response's id is the NEW row's, and it names the old one.
    expect(result.prompt_id).not.toBe(PROMPT);
    expect(result.supersedes_prompt_id).toBe(PROMPT);
    expect(result.text).toBe("which crm is best for a mid-market sales team?");
  });

  it("inserts rather than updating the text in place", async () => {
    await setup().update(PROMPT, { text: "a new wording?" });
    expect(calls.some((call) => call.sql.includes("INSERT INTO tracked_prompts"))).toBe(true);
    // The old row's TEXT is never rewritten — that is what would fake
    // continuity across two different questions.
    const textUpdates = calls.filter((call) => call.sql.includes("UPDATE tracked_prompts") && call.sql.includes("SET text"));
    expect(textUpdates).toHaveLength(0);
  });

  it("links the old row with superseded_by and archives it", async () => {
    await setup({ status: "active" }).update(PROMPT, { text: "a new wording?" });
    // The WRITE that links the rows: the prompt SELECT also names the column (to refuse a superseded row), so match on the verb too.
    const link = calls.find((call) => /^\s*UPDATE/i.test(call.sql) && call.sql.includes("superseded_by"));
    expect(link).toBeDefined();
    // Archived, so it stops capturing and releases its slot to the new row —
    // the net occupancy of an edit is zero.
    expect(link?.sql).toContain("archived");
  });

  it("carries the archetype and funnel stage onto the new row", async () => {
    // The new row is the same QUESTION reworded, so its classification is
    // unchanged. Re-deriving it would need the generator and the original
    // slot context, neither of which a PATCH has.
    await setup().update(PROMPT, { text: "a new wording?" });
    const insert = calls.find((call) => call.sql.includes("INSERT INTO tracked_prompts"));
    expect(insert?.params).toContain("recommendation");
    expect(insert?.params).toContain("consideration");
  });

  it("keeps `generation_source` rather than relabelling an edited prompt as manual", async () => {
    // `generation_source` records how the prompt came to EXIST. It was
    // generated and then reworded; `manual` would mean the customer typed it
    // from nothing. Relabelling would also silently shrink FR-CRD-08's
    // coverage denominator.
    await setup().update(PROMPT, { text: "a new wording?" });
    const insert = calls.find((call) => call.sql.includes("INSERT INTO tracked_prompts"));
    expect(insert?.params).toContain("generated");
  });

  it("refuses a 409 rather than a 500 when the new text collides with an existing prompt", async () => {
    // `ux_prompts_project_hash` is unique on (project_id, text_hash). Editing
    // a prompt into the exact wording of another one is a conflict the
    // customer can act on, not an unhandled database error — the same shape
    // as the project slug collision.
    const service = setup({
      failOn: { match: "INSERT INTO tracked_prompts", error: Object.assign(new Error("dup"), { code: "23505", constraint: "ux_prompts_project_hash" }) },
    });
    const error = await service.update(PROMPT, { text: "a duplicate wording?" }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("conflict");
  });

  it("treats an identical text as a no-op rather than superseding a prompt with itself", async () => {
    // Editing to the same wording would otherwise archive the row, insert a
    // byte-identical one, and break the metric series for no change at all —
    // and the insert would collide with the row it just archived.
    const result = await setup().update(PROMPT, { text: "Which crm do you recommend for mid market teams?" });
    expect(result.prompt_id).toBe(PROMPT);
    expect(result.supersedes_prompt_id).toBeNull();
    expect(calls.some((call) => call.sql.includes("INSERT INTO tracked_prompts"))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Refusals.
  // ---------------------------------------------------------------------------

  it("refuses an unknown prompt", async () => {
    const error = await setup({ missing: true }).update(PROMPT, { status: "paused" }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("not_found");
  });

  it("charges nothing, and touches no wallet or ledger", async () => {
    const result = await setup().update(PROMPT, { status: "paused" });
    expect(result.credits_charged).toBe(0);
    const touched = calls.map((call) => call.sql).join(" ").toLowerCase();
    for (const table of ["wallet", "credit_ledger", "debit", "reserve"]) {
      expect(touched, `lifecycle must not touch ${table}`).not.toContain(table);
    }
  });
});
