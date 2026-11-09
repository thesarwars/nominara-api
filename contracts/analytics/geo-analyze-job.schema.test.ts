import { describe, expect, it } from "vitest";
import { geoAnalyzeJobPayloadSchema, geoAnalyzeKey } from "./geo-analyze-job.schema.js";

const id = "0198a1f0-0000-7000-8000-000000000001";
const base = { projectId: id, sessionId: id, workspaceId: id, kid: "k1" };

describe("STORY-192 - the geo.analyze alignment job payload", () => {
  it("AC job - both kinds parse, `attempt` defaults to 0, and an unknown key or kind is refused", () => {
    expect(geoAnalyzeJobPayloadSchema.parse({ kind: "alignment_session", ...base })).toMatchObject({ attempt: 0 });
    expect(geoAnalyzeJobPayloadSchema.safeParse({ kind: "alignment_draft", ...base, attempt: 3 }).success).toBe(true);
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
});
