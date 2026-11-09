import { describe, expect, it } from "vitest";
import { geoAnalyzeJobPayloadSchema, geoAnalyzeKey } from "./geo-analyze-job.schema.js";

const id = "0198a1f0-0000-7000-8000-000000000001";
const base = { projectId: id, sessionId: id, workspaceId: id, kid: "k1" };

describe("STORY-192 - the geo.analyze alignment job payload", () => {
  it("AC job - both kinds parse, `attempt` defaults to 0, and an unknown key or kind is refused", () => {
    expect(geoAnalyzeJobPayloadSchema.parse({ kind: "alignment_session", ...base })).toMatchObject({ attempt: 0 });
    expect(geoAnalyzeJobPayloadSchema.safeParse({ kind: "alignment_draft", ...base, dueAt: "2026-11-09 10:00:00.123456+00", attempt: 3 }).success).toBe(true);
    expect(geoAnalyzeJobPayloadSchema.safeParse({ kind: "alignment_draft", ...base }).success, "a draft job names the save it belongs to").toBe(false);
    expect(geoAnalyzeJobPayloadSchema.safeParse({ kind: "alignment_session", ...base, extra: 1 }).success).toBe(false);
    expect(geoAnalyzeJobPayloadSchema.safeParse({ kind: "daily", ...base }).success).toBe(false);
    expect(geoAnalyzeJobPayloadSchema.safeParse({ kind: "alignment_session", ...base, attempt: -1 }).success).toBe(false);
  });

  it("AC job - the key is one per step: a redelivery shares it, the next attempt and the other kind do not", () => {
    const a = { projectId: id, sessionId: id, kind: "alignment_session" as const, attempt: 1 };
    expect(geoAnalyzeKey(a)).toBe(geoAnalyzeKey({ ...a }));
    expect(geoAnalyzeKey(a)).not.toBe(geoAnalyzeKey({ ...a, attempt: 2 }));
    expect(geoAnalyzeKey(a)).not.toBe(geoAnalyzeKey({ ...a, kind: "alignment_draft" }));
    expect(geoAnalyzeKey(a).startsWith(`geo:${id}:alignment:`)).toBe(true);
  });

  it("AC draft - every SAVE of a draft has its own key (the queue deduplicates by key for an hour), and a redelivery of one save's step shares it", () => {
    const draft = { projectId: id, sessionId: id, kind: "alignment_draft" as const, attempt: 0, dueAt: "2026-11-09 10:00:02.123456+00" };
    expect(geoAnalyzeKey(draft)).toBe(geoAnalyzeKey({ ...draft }));
    expect(geoAnalyzeKey(draft)).not.toBe(geoAnalyzeKey({ ...draft, dueAt: "2026-11-09 10:05:07.654321+00" }));
    expect(geoAnalyzeKey(draft)).not.toBe(geoAnalyzeKey({ ...draft, dueAt: "2026-11-09 10:00:02.123457+00" }));
    expect(geoAnalyzeKey(draft)).not.toBe(geoAnalyzeKey({ ...draft, attempt: 1 }));
  });
});
