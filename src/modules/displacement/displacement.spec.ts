import { Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { ClientBase } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  displacementDismissalResponseSchema,
  displacementFeedQuerySchema,
  displacementItemSchema,
} from "../../../contracts/analytics/index.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { AUDIT_METADATA_KEY } from "../../api/decorators/audit.decorator.js";
import { PROJECT_PARAM_KEY } from "../../api/decorators/project-param.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { SCOPED_BY_QUERY_KEY } from "../../api/decorators/scoped-by-query.decorator.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { DisplacementController } from "./displacement.controller.js";
import { DisplacementModule } from "./displacement.module.js";
import { DisplacementService } from "./displacement.service.js";

// STORY-022 — one compiles-test per scaffolded module.
describe("STORY-022 · DisplacementModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DisplacementModule] }).compile();
    expect(moduleRef.get(DisplacementController)).toBeInstanceOf(DisplacementController);
    await moduleRef.close();
  });
});

const ID = "0190e7a0-0000-7000-8000-000000000001";
const uuid = (n: number) => `0190e7a0-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("NEW-C-5 · route wiring (AC4)", () => {
  const reflector = new Reflector();
  const proto = DisplacementController.prototype as unknown as Record<string, () => void>;

  it("AC4 — the feed needs tracking:read, binds scope to :id, and is a paginated list", () => {
    const h = proto.feed!;
    expect(reflector.get(REQUIRE_PERMISSION_KEY, h)).toBe("tracking:read");
    expect(reflector.get(PROJECT_PARAM_KEY, h)).toBe("id");
    expect(reflector.get(API_CONTRACT_KEY, h)).toMatchObject({ operationId: "listProjectDisplacements", listOf: true });
  });

  it("AC3/AC4 — dismiss needs task:create (proposed, raised with the owner) and is audited", () => {
    const h = proto.dismiss!;
    expect(reflector.get(REQUIRE_PERMISSION_KEY, h)).toBe("task:create");
    expect(reflector.get(SCOPED_BY_QUERY_KEY, h)).toBe(true);
    expect(reflector.get(AUDIT_METADATA_KEY, h)).toMatchObject({ action: "displacement.dismissed", resourceType: "displacement" });
    expect(reflector.get(API_CONTRACT_KEY, h)).toMatchObject({ operationId: "dismissDisplacement" });
  });

  it("AC3/AC4 — restore needs task:create and is audited under its own action", () => {
    const h = proto.restore!;
    expect(reflector.get(REQUIRE_PERMISSION_KEY, h)).toBe("task:create");
    expect(reflector.get(SCOPED_BY_QUERY_KEY, h)).toBe(true);
    expect(reflector.get(AUDIT_METADATA_KEY, h)).toMatchObject({ action: "displacement.restored", resourceType: "displacement" });
    expect(reflector.get(API_CONTRACT_KEY, h)).toMatchObject({ operationId: "restoreDisplacement" });
  });
});

describe("NEW-C-5 · contract (AC1)", () => {
  const item = {
    id: ID,
    project_id: uuid(2),
    prompt_id: uuid(3),
    engine_key: "gemini",
    detected_at: "2026-10-01T00:00:00.000Z",
    kind: "position_lost",
    before_result_id: uuid(4),
    after_result_id: uuid(5),
    before_position: 1,
    after_position: null,
    before_position_class: "recommendation",
    after_position_class: null,
    takers: [],
    citation_gap: [],
    concept_gap: [],
    impact_score: 0.4,
    recovered_at: null,
    dismissed_at: null,
    task_id: null,
    recovery_task_count: 0,
    data_source: "live",
  };

  it("AC1 — a complete item parses, and an unknown key is refused (.strict())", () => {
    expect(displacementItemSchema.safeParse(item).success).toBe(true);
    expect(displacementItemSchema.safeParse({ ...item, extra: 1 }).success).toBe(false);
  });

  it("AC1 — a row without before_result_id or after_result_id cannot be expressed", () => {
    expect(displacementItemSchema.safeParse({ ...item, before_result_id: null }).success).toBe(false);
    expect(displacementItemSchema.safeParse({ ...item, after_result_id: undefined }).success).toBe(false);
  });

  it("AC1 — data_source is the one vocabulary and null means nothing measured; the old kind names are refused", () => {
    expect(displacementItemSchema.safeParse({ ...item, data_source: null }).success).toBe(true);
    expect(displacementItemSchema.safeParse({ ...item, data_source: "mock" }).success).toBe(false);
    expect(displacementItemSchema.safeParse({ ...item, kind: "class_downgrade" }).success).toBe(false);
    expect(displacementItemSchema.safeParse({ ...item, kind: "render_downgrade" }).success).toBe(false);
  });

  it("AC1 — recovery_task_count is a non-negative integer, never null", () => {
    expect(displacementItemSchema.safeParse({ ...item, recovery_task_count: null }).success).toBe(false);
    expect(displacementItemSchema.safeParse({ ...item, recovery_task_count: -1 }).success).toBe(false);
  });

  it("AC2 — the query is strict, include_dismissed defaults to false, and kind is the DB vocabulary", () => {
    expect(displacementFeedQuerySchema.parse({}).include_dismissed).toBe("false");
    expect(displacementFeedQuerySchema.safeParse({ kind: "recommendation_lost", engine: "gemini" }).success).toBe(true);
    expect(displacementFeedQuerySchema.safeParse({ kind: "class_downgrade" }).success).toBe(false);
    expect(displacementFeedQuerySchema.safeParse({ unknown: "x" }).success).toBe(false);
    expect(displacementFeedQuerySchema.parse({ limit: "9999" }).limit).toBe(200);
  });

  it("AC3 — the dismissal response is {id, dismissed_at|null} and strict", () => {
    expect(displacementDismissalResponseSchema.safeParse({ id: ID, dismissed_at: null }).success).toBe(true);
    expect(displacementDismissalResponseSchema.safeParse({ id: ID, dismissed_at: "2026-10-01T00:00:00Z", x: 1 }).success).toBe(false);
  });
});

/** A fake pg client routing on the statement text. */
function fakeClient(routes: { select?: unknown[]; update?: unknown[] }, seen: string[] = []): ClientBase {
  return {
    query: async (sql: string) => {
      seen.push(sql);
      if (/^\s*UPDATE displacement_events/i.test(sql)) return { rows: routes.update ?? [] };
      if (/FROM displacement_events/i.test(sql)) return { rows: routes.select ?? [] };
      return { rows: [] };
    },
  } as unknown as ClientBase;
}
const ctx = { workspaceId: "ws-1", actorId: "actor-1" };
const run = <T>(client: ClientBase, fn: () => Promise<T>) => withTenantContext(client, ctx, fn);

describe("NEW-C-5 · dismiss and restore (AC3, AC5)", () => {
  const service = new DisplacementService();
  const live = { id: ID, dismissed_at: null, in_scope: true };
  const dismissed = { id: ID, dismissed_at: new Date("2026-10-01T00:00:00Z"), in_scope: true };

  it("AC5 — an id RLS hides is 404", async () => {
    await expect(run(fakeClient({ select: [] }), () => service.dismiss(ID))).rejects.toMatchObject({ code: "not_found" });
    await expect(run(fakeClient({ select: [] }), () => service.restore(ID))).rejects.toMatchObject({ code: "not_found" });
  });

  it("AC3 — restoring a row that is not dismissed is 409, and nothing is written", async () => {
    const seen: string[] = [];
    await expect(run(fakeClient({ select: [live] }, seen), () => service.restore(ID))).rejects.toMatchObject({ code: "conflict" });
    expect(seen.some((s) => /UPDATE displacement_events/i.test(s))).toBe(false);
  });

  it("AC3 — dismiss stamps dismissed_at and the actor; restore clears both", async () => {
    const seen: string[] = [];
    const stamp = new Date("2026-10-02T00:00:00Z");
    const out = await run(fakeClient({ select: [live], update: [{ id: ID, dismissed_at: stamp }] }, seen), () => service.dismiss(ID));
    expect(out).toEqual({ id: ID, dismissed_at: stamp.toISOString() });
    expect(displacementDismissalResponseSchema.safeParse(out).success).toBe(true);
    expect(seen.find((s) => /^\s*UPDATE/i.test(s))).toMatch(/dismissed_by/);

    const back = await run(fakeClient({ select: [dismissed], update: [{ id: ID, dismissed_at: null }] }), () => service.restore(ID));
    expect(back).toEqual({ id: ID, dismissed_at: null });
  });

  it("AC3 — dismissing an already-dismissed row is a no-op that keeps the first timestamp", async () => {
    const seen: string[] = [];
    const out = await run(fakeClient({ select: [dismissed] }, seen), () => service.dismiss(ID));
    expect(out.dismissed_at).toBe("2026-10-01T00:00:00.000Z");
    expect(seen.some((s) => /UPDATE displacement_events/i.test(s))).toBe(false);
  });

  it("AC4 — a row in the tenant but outside the caller's project scope is a 403, not a 404", async () => {
    await expect(run(fakeClient({ select: [{ ...live, in_scope: false }] }), () => service.dismiss(ID))).rejects.toMatchObject({
      status: 403,
    });
  });

  it("observability — counts the change and logs workspace and displacement IDs only", async () => {
    const logs: unknown[] = [];
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(m));
    await run(fakeClient({ select: [live], update: [{ id: ID, dismissed_at: new Date() }] }), () => service.dismiss(ID));
    log.mockRestore();
    expect(logs).toContainEqual({ metric: "nominara_displacement_state_changes_total", value: 1, action: "dismissed" });
    expect(logs).toContainEqual({ message: "displacement dismissed", workspace_id: "ws-1", displacement_id: ID });
  });
});

describe("NEW-C-5 · feed (AC2, AC5)", () => {
  const service = new DisplacementService();

  it("AC5 — a project RLS hides is 404 before any feed query runs", async () => {
    const seen: string[] = [];
    const query = displacementFeedQuerySchema.parse({});
    await expect(run(fakeClient({}, seen), () => service.feed(uuid(9), query))).rejects.toMatchObject({ code: "not_found" });
    expect(seen.some((s) => /FROM displacement_events/i.test(s))).toBe(false);
  });
});
