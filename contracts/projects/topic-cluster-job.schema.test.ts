import { describe, expect, it } from "vitest";
import { topicClusterJobPayloadSchema } from "./topic-cluster-job.schema.js";

const valid = { workspaceId: "0198f3a1-7c11-7000-8000-000000000001", kid: "k1", projectId: "0198f3a1-7c11-7000-8000-000000000002", reason: "weekly" };

describe("STORY-047 · topic.cluster job payload", () => {
  it("accepts a well-formed payload", () => {
    expect(topicClusterJobPayloadSchema.parse(valid)).toEqual(valid);
  });
  it("rejects an unknown key rather than dropping it", () => {
    expect(() => topicClusterJobPayloadSchema.parse({ ...valid, extra: 1 })).toThrow();
  });
  it("rejects an unknown reason and a non-uuid project", () => {
    expect(() => topicClusterJobPayloadSchema.parse({ ...valid, reason: "manual" })).toThrow();
    expect(() => topicClusterJobPayloadSchema.parse({ ...valid, projectId: "p1" })).toThrow();
  });
});
