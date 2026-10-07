import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AnalyticsModule } from "./analytics.module.js";
import { AnalyticsController } from "./analytics.controller.js";
import { GrowthMapController } from "./growth-map.controller.js";
import { GrowthMapService } from "./growth-map.service.js";
import { ScorecardsController } from "./scorecards.controller.js";
import { ScorecardsService } from "./scorecards.service.js";

// STORY-022 scaffolded this as a compiles-test; STORY-136 and STORY-137 give
// the module its first routes, so the test now asserts they are mounted.
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

  it("STORY-137 — mounts the growth-map route and its service", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AnalyticsModule] }).compile();
    expect(moduleRef.get(GrowthMapController)).toBeInstanceOf(GrowthMapController);
    expect(moduleRef.get(GrowthMapService)).toBeInstanceOf(GrowthMapService);
    await moduleRef.close();
  });
});

describe("NEW-C-7 sources", () => {
  it("mounts the sources route and its service", async () => {
    const { SourcesController } = await import("./sources.controller.js");
    const { SourcesService } = await import("./sources.service.js");
    const moduleRef = await Test.createTestingModule({ imports: [AnalyticsModule] }).compile();
    expect(moduleRef.get(SourcesController)).toBeInstanceOf(SourcesController);
    expect(moduleRef.get(SourcesService)).toBeInstanceOf(SourcesService);
    await moduleRef.close();
  });
});
