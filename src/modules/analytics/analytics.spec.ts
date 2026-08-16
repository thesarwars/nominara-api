import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AnalyticsModule } from "./analytics.module.js";
import { AnalyticsController } from "./analytics.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · AnalyticsModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AnalyticsModule] }).compile();
    expect(moduleRef.get(AnalyticsController)).toBeInstanceOf(AnalyticsController);
    await moduleRef.close();
  });
});
