import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// STORY-078 round 3 - the PUBLISHED contract for GET /tools/runs. A listOf operation's responseSchema is the array of items, so
// `data` must be published as an array of the tool-run schema, not as a single object.
interface Schema {
  readonly type?: string;
  readonly items?: Schema;
  readonly properties?: Record<string, Schema>;
}
const document = JSON.parse(readFileSync(new URL("../../contracts/openapi.generated.json", import.meta.url), "utf8")) as {
  paths: Record<string, { get?: { operationId: string; responses: Record<string, { content?: Record<string, { schema?: Schema }> }> } }>;
};

describe("published tool-run list contract", () => {
  it("STORY-078 AC1 · listToolRuns publishes `data` as an array of tool runs", () => {
    const op = document.paths["/v1/tools/runs"]?.get;
    expect(op?.operationId).toBe("listToolRuns");
    const data = op?.responses["200"]?.content?.["application/json"]?.schema?.properties?.["data"];
    expect(data?.type).toBe("array");
    expect(data?.items?.properties).toHaveProperty("tool_key");
    expect(data?.items?.properties).toHaveProperty("headline");
  });
});
