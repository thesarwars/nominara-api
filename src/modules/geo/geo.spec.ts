import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { GeoModule } from "./geo.module.js";
import { AlignmentController } from "./alignment.controller.js";
import { AlignmentService } from "./alignment.service.js";
import { GeoController } from "./geo.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · GeoModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    // STORY-062 AC10: GeoModule imports TasksModule (the digest links an open task through TasksService), which builds the
    // realtime publisher and validates the env eagerly.
    const originalEnv = { ...process.env };
    applyFakeApiEnv();
    try {
      const moduleRef = await Test.createTestingModule({ imports: [GeoModule] }).compile();
      expect(moduleRef.get(GeoController)).toBeInstanceOf(GeoController);
      // STORY-192: the alignment routes and their service resolve (the queue producer and the AUX patch reader are wired).
      expect(moduleRef.get(AlignmentController)).toBeInstanceOf(AlignmentController);
      expect(moduleRef.get(AlignmentService)).toBeInstanceOf(AlignmentService);
      await moduleRef.close();
    } finally {
      process.env = originalEnv;
    }
  });
});
