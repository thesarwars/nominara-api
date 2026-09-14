import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  DAILY_LOOKUPS_HEADER,
  DAILY_RESETS_AT_HEADER,
  DailyCapGuard,
  type DailyCapScopedRequest,
} from "../../src/api/guards/daily-cap.guard.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";

// STORY-071 scenarios 8 and 11, plus the guard's own decision logic.
//
// The counter's SQL is proven against real Postgres in
// test/integration/daily-cap.spec.ts. What is testable without a container is
// what the guard decides BEFORE it touches one — which is the whole of AC9,
// the requirement that an uncapped tier never writes a row at all.

const WORKSPACE = "01a06ccd-9e37-7f0c-957b-195fa6d263dd";

interface Harness {
  guard: DailyCapGuard;
  connect: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
  request: DailyCapScopedRequest;
  context: ExecutionContext;
}

function harnessFor(options: {
  action?: string | null;
  limit?: unknown;
  rows?: { remaining_today: string; used_count: string; limit_count: string }[];
}): Harness {
  const reflector = { getAllAndOverride: () => options.action ?? undefined } as unknown as Reflector;
  const resolver = {
    resolveForWorkspace: () =>
      Promise.resolve({
        workspace_id: WORKSPACE,
        plan_key: "free",
        entitlement_version: 1,
        entitlements: { "credits.lookups_per_day_max": { value: options.limit, source: "plan", live: true } },
      }),
  } as unknown as EntitlementResolver;

  const query = vi.fn(() => Promise.resolve({ rows: options.rows ?? [], rowCount: options.rows?.length ?? 0 }));
  const release = vi.fn();
  const connect = vi.fn(() => Promise.resolve({ query, release }));
  const pool = { connect } as unknown as Pool;

  const header = vi.fn();
  const request: DailyCapScopedRequest = { tenant: { workspaceId: WORKSPACE } } as DailyCapScopedRequest;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ header }) }),
  } as unknown as ExecutionContext;

  return { guard: new DailyCapGuard(reflector, resolver, pool), connect, header, request, context };
}

const ALLOWED = [{ remaining_today: "2", used_count: "1", limit_count: "3" }];

describe("STORY-071 · DailyCapGuard", () => {
  it("passes a route with no @DailyCap through without resolving anything", async () => {
    const harness = harnessFor({ action: null });
    await expect(harness.guard.canActivate(harness.context)).resolves.toBe(true);
    expect(harness.connect).not.toHaveBeenCalled();
  });

  it("scenario 8 — A TIER WITH NO DAILY CAP WRITES NO ROW AT ALL", async () => {
    // Not "writes an effectively-infinite row". Every paid tier carries
    // `credits.lookups_per_day_max: null`, and a row per workspace per action
    // per day for all of them would answer a question their plan does not ask.
    const harness = harnessFor({ action: "lookup", limit: null });
    await expect(harness.guard.canActivate(harness.context)).resolves.toBe(true);
    expect(harness.connect).not.toHaveBeenCalled();
  });

  it("treats a zero limit as uncapped here rather than as a cap of nothing", async () => {
    // A `0` is a different claim — the action is not available at all — and
    // its remediation is upgrade, not wait. That belongs to
    // `feature_not_in_plan`, exactly as QuotaGuard separates the two. What
    // this guard must not do is report "wait for a reset" to someone whose
    // reset will never help them.
    const harness = harnessFor({ action: "lookup", limit: 0 });
    await expect(harness.guard.canActivate(harness.context)).resolves.toBe(true);
    expect(harness.connect).not.toHaveBeenCalled();
  });

  it("scenario 11 — exposes remaining-today and the reset on the response", async () => {
    const harness = harnessFor({ action: "lookup", limit: 3, rows: ALLOWED });
    await harness.guard.canActivate(harness.context);

    expect(harness.header).toHaveBeenCalledWith(DAILY_LOOKUPS_HEADER, "1/3");
    const resetCall = harness.header.mock.calls.find((call) => call[0] === DAILY_RESETS_AT_HEADER);
    expect(resetCall?.[1]).toMatch(/T00:00:00\.000Z$/);
  });

  it("scenario 2 — exhaustion is the daily failure, with the action code and the reset", async () => {
    const harness = harnessFor({ action: "lookup", limit: 3, rows: [] });
    await expect(harness.guard.canActivate(harness.context)).rejects.toMatchObject({
      code: "daily_limit_reached",
      details: { action_code: "lookup", limit: 3, used: 3 },
    });
  });

  it("hands a compensation forward only when it actually consumed an allowance", async () => {
    const allowed = harnessFor({ action: "lookup", limit: 3, rows: ALLOWED });
    await allowed.guard.canActivate(allowed.context);
    expect(allowed.request.dailyCapCompensation).toEqual({ workspaceId: WORKSPACE, action: "lookup" });

    const uncapped = harnessFor({ action: "lookup", limit: null });
    await uncapped.guard.canActivate(uncapped.context);
    expect(uncapped.request.dailyCapCompensation).toBeUndefined();
  });

  it("refuses a capped route with no workspace rather than allowing it against a default", async () => {
    const harness = harnessFor({ action: "lookup", limit: 3, rows: ALLOWED });
    delete (harness.request as { tenant?: unknown }).tenant;
    await expect(harness.guard.canActivate(harness.context)).rejects.toThrow(/no workspace is resolved/);
  });

  it("releases the pooled client even when the counter refuses", async () => {
    const harness = harnessFor({ action: "lookup", limit: 3, rows: [] });
    await expect(harness.guard.canActivate(harness.context)).rejects.toBeDefined();
    const client = await harness.connect.mock.results[0]!.value;
    expect((client as { release: ReturnType<typeof vi.fn> }).release).toHaveBeenCalled();
  });
});
