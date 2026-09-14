import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AnalyticsModule } from "./analytics.module.js";
import { AnalyticsController } from "./analytics.controller.js";
import { ScorecardsController } from "./scorecards.controller.js";
import { ScorecardsService } from "./scorecards.service.js";

// STORY-022 scaffolded this as a compiles-test; STORY-136 gives the module
// its first route, so the test now asserts that route is actually mounted.
describe("AnalyticsModule", () => {
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
});
