import { describe, expect, it } from "vitest";
import { nameMatchJudgeJobPayloadSchema, nameMatchJudgeKey } from "./name-match-judge-job.schema.js";

const id = "0198a1f0-0000-7000-8000-000000000001";
const base = { kind: "name_match_judge" as const, projectId: id, judgeVersion: "gemini-2.5-flash:name-match-v1", day: "2026-11-12", workspaceId: id, kid: "k1" };

describe("STORY-191 - the name-match judge job payload", () => {
  it("parses the payload and refuses an unknown key, a missing field or a malformed day", () => {
    expect(nameMatchJudgeJobPayloadSchema.safeParse(base).success).toBe(true);
    expect(nameMatchJudgeJobPayloadSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(nameMatchJudgeJobPayloadSchema.safeParse({ ...base, judgeVersion: "" }).success).toBe(false);
    expect(nameMatchJudgeJobPayloadSchema.safeParse({ ...base, day: "12/11/2026" }).success).toBe(false);
    expect(nameMatchJudgeJobPayloadSchema.safeParse({ ...base, kind: "alignment_session" }).success).toBe(false);
  });

  it("the key is one per project, judge version and day: a redelivery shares it and nothing else does", () => {
    expect(nameMatchJudgeKey(base)).toBe(nameMatchJudgeKey({ ...base }));
    expect(nameMatchJudgeKey(base)).not.toBe(nameMatchJudgeKey({ ...base, day: "2026-11-13" }));
    expect(nameMatchJudgeKey(base)).not.toBe(nameMatchJudgeKey({ ...base, judgeVersion: "other:name-match-v1" }));
    expect(nameMatchJudgeKey(base)).not.toBe(nameMatchJudgeKey({ ...base, projectId: "0198a1f0-0000-7000-8000-000000000002" }));
    expect(nameMatchJudgeKey(base).startsWith(`geo:${id}:name-match:`)).toBe(true);
  });
});
