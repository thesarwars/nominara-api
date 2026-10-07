import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainError } from "../../api/errors/domain-errors.js";
import { ProjectOutOfScopeException } from "../../tenancy/errors.js";
import * as metrics from "../../lib/telemetry/metrics.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { TopicsService } from "./topics.service.js";

// NEW-B-3 — GET /projects/{id}/topics and PATCH /topics/{id}.
// STORY-047 AC "The rename endpoint records that the label source is human"
// (recorded as 'user', the value topic_clusters' CHECK allows).

const WS = "11111111-1111-7111-8111-111111111111";
const PROJECT = "33333333-3333-7333-8333-333333333333";
const OTHER_PROJECT = "44444444-4444-7444-8444-444444444444";
const TOPIC = "55555555-5555-7555-8555-555555555555";

interface Recorded {
  readonly sql: string;
  readonly params: unknown[];
}

function topicRow(overrides: Record<string, unknown> = {}) {
  return {
    topic_id: TOPIC,
    project_id: PROJECT,
    label: "Enterprise scale",
    label_source: "auto",
    prompt_count: 4,
    commercial_intent: 0.7,
    visibility_score: null,
    authority_rank: null,
    leader_entity_id: null,
    gap_priority: null,
    achievability: null,
    computed_at: null,
    ...overrides,
  };
}

function setup(opts: { projectExists?: boolean; rows?: unknown[]; renamed?: unknown[]; error?: Error; scope?: string[] } = {}) {
  const calls: Recorded[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("UPDATE topic_clusters")) {
        if (opts.error !== undefined) throw opts.error;
        return { rows: opts.renamed ?? [topicRow({ label_source: "user" })] };
      }
      if (sql.includes("FROM projects")) return { rows: opts.projectExists === false ? [] : [{ id: PROJECT }] };
      if (sql.includes("project_id FROM topic_clusters")) return { rows: opts.rows ?? [{ project_id: PROJECT }] };
      return { rows: opts.rows ?? [] };
    }),
  };
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
    client,
    context: { workspaceId: WS, actorId: "a", scopeProjectIds: opts.scope },
  } as never);
  return { service: new TopicsService(), calls };
}

describe("NEW-B-3 · TopicsService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("NEW-B-3 AC3 — a project with no clusters returns [] honestly", async () => {
    const { service } = setup({ rows: [] });
    await expect(service.list(PROJECT)).resolves.toEqual({ topics: [] });
  });

  it("NEW-B-3 — an unknown project is 404, not an empty list", async () => {
    const { service } = setup({ projectExists: false });
    await expect(service.list(PROJECT)).rejects.toMatchObject({ code: "not_found" } satisfies Partial<DomainError>);
  });

  it("NEW-B-3 — null stays null: an unmeasured topic is not a zero", async () => {
    const { service } = setup({ rows: [topicRow()] });
    const { topics } = await service.list(PROJECT);
    expect(topics[0]?.visibility_score).toBeNull();
    expect(topics[0]?.gap_priority).toBeNull();
  });

  it("NEW-B-3 — numeric columns arrive as numbers; 0 survives as 0", async () => {
    const { service } = setup({ rows: [topicRow({ visibility_score: "0.000", gap_priority: 0, authority_rank: 0 })] });
    const { topics } = await service.list(PROJECT);
    expect(topics[0]?.visibility_score).toBe(0);
    expect(topics[0]?.gap_priority).toBe(0);
    expect(topics[0]?.authority_rank).toBe(0);
  });

  it("NEW-B-3 — the list is scoped to the project and excludes nothing it should not", async () => {
    const { service, calls } = setup({ rows: [] });
    await service.list(PROJECT);
    const q = calls.find((c) => c.sql.includes("FROM topic_clusters"));
    expect(q?.sql).toContain("project_id = $1");
    expect(q?.params[0]).toBe(PROJECT);
  });

  it("STORY-047 AC11 — rename sets label_source to 'user'", async () => {
    const { service, calls } = setup();
    const topic = await service.rename(TOPIC, { label: "Pricing" });
    expect(topic.label_source).toBe("user");
    const update = calls.find((c) => c.sql.includes("UPDATE topic_clusters"));
    expect(update?.sql).toContain("label_source = 'user'");
    expect(update?.params).toContain("Pricing");
  });

  it("NEW-B-3 observability — a rename increments its counter and logs the id, never the label", async () => {
    const counter = vi.spyOn(metrics, "incrementCounter");
    const { service } = setup();
    const logs: unknown[] = [];
    vi.spyOn((service as unknown as { logger: { log: (m: unknown) => void } }).logger, "log").mockImplementation((m) => {
      logs.push(m);
    });
    await service.rename(TOPIC, { label: "Secret customer phrase" });
    expect(counter).toHaveBeenCalledWith("nominara_topics_renamed_total");
    expect(JSON.stringify(logs)).toContain(TOPIC);
    expect(JSON.stringify(logs)).not.toContain("Secret customer phrase");
  });

  it("NEW-B-3 — renaming an unknown topic is 404", async () => {
    const { service } = setup({ rows: [] });
    await expect(service.rename(TOPIC, { label: "x" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("NEW-B-3 — a label another topic in the project already has is 409 conflict", async () => {
    const dup = Object.assign(new Error("dup"), { code: "23505" });
    const { service } = setup({ error: dup });
    await expect(service.rename(TOPIC, { label: "Pricing" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("NEW-B-3 AC4 — a scoped manager renaming a topic of an out-of-scope project is a 403, not a 404", async () => {
    const { service } = setup({ scope: [OTHER_PROJECT] });
    await expect(service.rename(TOPIC, { label: "x" })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
  });

  it("NEW-B-3 AC4 — a scoped manager renaming an in-scope topic succeeds", async () => {
    const { service } = setup({ scope: [PROJECT] });
    await expect(service.rename(TOPIC, { label: "x" })).resolves.toMatchObject({ topic_id: TOPIC });
  });

  it("NEW-B-3 — an unrestricted member (no scope) is not blocked", async () => {
    const { service } = setup();
    await expect(service.rename(TOPIC, { label: "x" })).resolves.toBeDefined();
  });
});
