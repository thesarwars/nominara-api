import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "../../src/contracts/generate.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-097 AC "Assets" / owner decision 69 (c) - `GET /v1/themes/{id}/assets/{slot}` STREAMS the stored image from the platform origin.
// A binary route has no JSON envelope, so the contract describes the image media types with a binary schema and NOTHING JSON for the
// success status. Declared (`binary`), never inferred from a missing responseSchema.

describe("STORY-097 · a binary route is published with its image media types", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => applyFakeApiEnv());
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("097-B1 · fetchThemeAsset documents 200 as png, jpeg and webp binary content, not as a JSON envelope and not as a 302", { timeout: 60_000 }, async () => {
    const document = await generateOpenApiDocument();
    const operation = document.paths["/v1/themes/{id}/assets/{slot}"]?.get;
    expect(operation?.operationId).toBe("fetchThemeAsset");
    expect(Object.keys(operation!.responses)).toContain("200");
    expect(Object.keys(operation!.responses)).not.toContain("302");
    const ok = operation!.responses["200"] as { content?: Record<string, { schema: unknown }> };
    expect(Object.keys(ok.content ?? {}).sort()).toEqual(["image/jpeg", "image/png", "image/webp"]);
    for (const media of Object.values(ok.content ?? {})) expect(media.schema).toEqual({ type: "string", format: "binary" });
    expect(Object.keys(operation!.responses)).toEqual(expect.arrayContaining(["500", "default"]));
  });
});
