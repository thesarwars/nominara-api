import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "../../src/contracts/generate.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-181 AC4 - `GET /v1/results/{id}/raw` answers 302 to a 60-second signed URL (api-specification.md section 3). A redirect has
// no body, so the contract describes the status and the Location header and NOTHING else: an enveloped `data: null` 200 would be a
// description of a response the server never sends, which is the falsehood voidResponse was introduced to stop.

describe("STORY-181 AC4 · a redirect route is published as a 302 with a Location header and no body", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => applyFakeApiEnv());
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("181-C1 · GET /v1/results/{id}/raw documents 302 + Location and a void envelope, and no 200", async () => {
    const document = await generateOpenApiDocument();
    const operation = document.paths["/v1/results/{id}/raw"]?.get;
    expect(operation?.operationId).toBe("getResultRaw");
    expect(Object.keys(operation!.responses)).toContain("302");
    expect(Object.keys(operation!.responses)).not.toContain("200");
    const found = operation!.responses["302"] as {
      headers?: Record<string, { required?: boolean }>;
      content?: Record<string, { schema: { properties?: Record<string, { type?: string }> } }>;
    };
    expect(found.headers?.Location?.required).toBe(true);
    const envelope = found.content?.["application/json"]?.schema.properties;
    expect(envelope?.data).toEqual({ type: "null" });
    expect(Object.keys(envelope ?? {})).not.toContain("url");
  });

  it("181-C2 · it still documents the shared error body", async () => {
    const document = await generateOpenApiDocument();
    const operation = document.paths["/v1/results/{id}/raw"]?.get;
    expect(Object.keys(operation!.responses)).toEqual(expect.arrayContaining(["500", "default"]));
  });
});
