import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { TrackingModule } from "./tracking.module.js";
import { TrackingController } from "./tracking.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · TrackingModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TrackingModule] }).compile();
    expect(moduleRef.get(TrackingController)).toBeInstanceOf(TrackingController);
    await moduleRef.close();
  });
});
