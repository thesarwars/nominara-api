import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { portalMatrixResponseSchema } from "../portal/portal-read.schema.js";
import { methodologyFooterSchema } from "../reports/methodology-footer.schema.js";
import { competitorPanelResponseSchema } from "./competitor-panel-response.schema.js";
import { dataSourceSchema } from "./data-source.schema.js";
import { geoStructureDetailSchema } from "./geo-insights.schema.js";

// ONE data_source vocabulary on every surface: live | demo | mixed, and null
// for "nothing was measured". Competitors, GEO, reports and the portal used to
// carry their own live|demo enums, so the same engine could read `demo` on
// one screen and `mixed` on the next.

describe("data_source — one vocabulary across surfaces (owner decision, checkpoint 1)", () => {
  it("the vocabulary is exactly live, demo, mixed", () => {
    expect(dataSourceSchema.options).toEqual(["live", "demo", "mixed"]);
  });

  it.each(["live", "demo", "mixed", null])("competitor panel accepts %s per engine", (value) => {
    const field = competitorPanelResponseSchema.shape.engine_data_source;
    expect(field.safeParse({ gemini: value }).success).toBe(true);
  });

  it.each(["live", "demo", "mixed"])("GEO structure engine accepts %s", (value) => {
    const engine = geoStructureDetailSchema.shape.engines.element.shape.data_source;
    expect(engine.safeParse(value).success).toBe(true);
  });

  it.each(["live", "demo", "mixed", null])("methodology footer engine source accepts %s", (value) => {
    const footer = {
      data_through: null,
      engines: ["gemini"],
      engine_data_sources: [{ engine_key: "gemini", data_source: value }],
      timeframe: "30d",
      sample_size: 0,
      live_capture_ratio: null,
      scoring_version: "v1",
      weight_overrides: null,
      note: "n",
    };
    expect(methodologyFooterSchema.safeParse(footer).success).toBe(true);
  });

  it.each(["live", "demo", "mixed", null])("portal matrix engine accepts %s", (value) => {
    const engine = { engine_key: "gemini", data_source: value, visibility_score: null, presence_rate: null, share_of_voice: null };
    expect(portalMatrixResponseSchema.safeParse({ engines: [engine] }).success).toBe(true);
  });

  it("every surface still refuses a value outside the vocabulary", () => {
    expect(competitorPanelResponseSchema.shape.engine_data_source.safeParse({ gemini: "mock" }).success).toBe(false);
    expect(geoStructureDetailSchema.shape.engines.element.shape.data_source.safeParse("mock").success).toBe(false);
    expect(
      portalMatrixResponseSchema.safeParse({
        engines: [{ engine_key: "gemini", data_source: "mock", visibility_score: null, presence_rate: null, share_of_voice: null }],
      }).success,
    ).toBe(false);
  });

  it("no contract declares its own live/demo enum: the vocabulary is defined once", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) files.push(path);
      }
    };
    walk(root);
    const own = files.filter((path) => {
      if (path.endsWith(join("analytics", "data-source.schema.ts"))) return false;
      return /\[\s*["']live["']\s*,\s*["']demo["']/.test(readFileSync(path, "utf8"));
    });
    expect(own).toEqual([]);
  });
});
