import "reflect-metadata";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { schemaBuilderUrlAcceptedSchema, schemaBuilderUrlRequestSchema } from "../../../contracts/tools/index.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { RATE_LIMIT_CLASS_KEY } from "../../api/rate-limit/route-class.js";
import { ToolsController } from "./tools.controller.js";

// STORY-083 AC5 - the route's declared shape, and the request half's reach: it may touch the queue and the URL guard (DNS, no socket), and nothing that fetches.

describe("POST /tools/schema-builder/url · route", () => {
  const handler = (ToolsController.prototype as unknown as { schemaBuilderUrlStart?: (...a: never[]) => unknown }).schemaBuilderUrlStart;

  it("SU-R1 is lookup:execute (the Schema Builder's permission), contracted strict, idempotency-keyed, and on the free fetch tool's rate class", () => {
    expect(handler).toBeTypeOf("function");
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler!)).toBe("lookup:execute");
    expect(Reflect.getMetadata(RATE_LIMIT_CLASS_KEY, handler!)).toBe("tool_site_files");
    expect(Reflect.getMetadata(API_CONTRACT_KEY, handler!)).toMatchObject({ operationId: "startSchemaBuilderUrlCheck", requestSchema: schemaBuilderUrlRequestSchema, responseSchema: schemaBuilderUrlAcceptedSchema, requiresIdempotencyKey: true });
  });

  it("SU-R2 the request service imports no fetcher or socket module: it can reach the queue and the URL guard only", () => {
    const text = readFileSync(path.join(import.meta.dirname, "schema-builder-url.service.ts"), "utf8");
    const imports = text.split("\n").filter((line) => /^\s*import\b.*\bfrom\b/u.test(line));
    for (const line of imports) expect(line, line).not.toMatch(/node:https?|undici|axios|"got"|crawl-gate|page-fetcher|schema-builder-url-check/u);
    // The one thing it takes from the guarded fetcher is the refusal TYPE (to turn it into a 422); never the fetch function.
    expect(imports.filter((line) => /guarded-fetch\.js"/u.test(line))).toEqual(['import { GuardedFetchRefusal } from "../../lib/net/guarded-fetch.js";']);
    expect(text).not.toMatch(/\bfetch\(|guardedFetch\(|crawlGatedFetch\(/u);
  });
});
