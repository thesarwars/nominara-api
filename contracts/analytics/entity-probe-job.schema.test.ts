import { describe, expect, it } from "vitest";
import { entityProbeJobPayloadSchema, entityProbeKey } from "./entity-probe-job.schema.js";

const id = "0198a1f0-0000-7000-8000-000000000001";
const base = { kind: "entity_probe" as const, projectId: id, day: "2026-11-12", workspaceId: id, kid: "k1" };

describe("STORY-060 - the entity profile probe job payload", () => {
  it("parses the payload and refuses an unknown key, a missing field, a malformed day or another kind", () => {
    expect(entityProbeJobPayloadSchema.safeParse(base).success).toBe(true);
    expect(entityProbeJobPayloadSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(entityProbeJobPayloadSchema.safeParse({ ...base, projectId: "nope" }).success).toBe(false);
    expect(entityProbeJobPayloadSchema.safeParse({ ...base, day: "12/11/2026" }).success).toBe(false);
    expect(entityProbeJobPayloadSchema.safeParse({ ...base, kind: "name_match_judge" }).success).toBe(false);
  });

  it("the key is one per project and day: a redelivery shares it and nothing else does", () => {
    expect(entityProbeKey(base)).toBe(entityProbeKey({ ...base }));
    expect(entityProbeKey(base)).not.toBe(entityProbeKey({ ...base, day: "2026-11-13" }));
    expect(entityProbeKey(base)).not.toBe(entityProbeKey({ ...base, projectId: "0198a1f0-0000-7000-8000-000000000002" }));
    expect(entityProbeKey(base).startsWith(`geo:${id}:entity-probe:`)).toBe(true);
  });
});
