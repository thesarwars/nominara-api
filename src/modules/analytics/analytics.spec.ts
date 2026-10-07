import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { AnalyticsModule } from "./analytics.module.js";
import { AnalyticsController } from "./analytics.controller.js";
import { CompetitorPanelController } from "./competitor-panel.controller.js";
import { CompetitorPanelService } from "./competitor-panel.service.js";
import { GrowthMapController } from "./growth-map.controller.js";
import { GrowthMapService } from "./growth-map.service.js";
import { ScorecardsController } from "./scorecards.controller.js";
import { ScorecardsService } from "./scorecards.service.js";

// STORY-022 scaffolded this as a compiles-test; STORY-136 and STORY-137 give
// the module its first routes, so the test now asserts they are mounted.
describe("AnalyticsModule", () => {
  // NEW-C-1 — the competitor panel reads the plan's competitor cap through
  // EntitlementsModule, whose factories read the environment at .compile().
  const originalEnv = { ...process.env };
  beforeEach(() => {
    applyFakeApiEnv();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AnalyticsModule] }).compile();
    expect(moduleRef.get(AnalyticsController)).toBeInstanceOf(AnalyticsController);
    await moduleRef.close();
  });

  it("STORY-136 — mounts the scorecards route and its service", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AnalyticsModule] }).compile();
    expect(moduleRef.get(ScorecardsController)).toBeInstanceOf(ScorecardsController);
    expect(moduleRef.get(ScorecardsService)).toBeInstanceOf(ScorecardsService);
    await moduleRef.close();
  });

  it("STORY-137 — mounts the growth-map route and its service", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AnalyticsModule] }).compile();
    expect(moduleRef.get(GrowthMapController)).toBeInstanceOf(GrowthMapController);
    expect(moduleRef.get(GrowthMapService)).toBeInstanceOf(GrowthMapService);
    await moduleRef.close();
  });

  it("NEW-C-1 — mounts the competitor panel route and its service", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AnalyticsModule] }).compile();
    expect(moduleRef.get(CompetitorPanelController)).toBeInstanceOf(CompetitorPanelController);
    expect(moduleRef.get(CompetitorPanelService)).toBeInstanceOf(CompetitorPanelService);
    await moduleRef.close();
  });
});
