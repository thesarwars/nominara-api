import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { MatrixController } from "./matrix.controller.js";
import { RunEstimateService } from "./run-estimate.service.js";
import { RunLifecycleService } from "./run-lifecycle.service.js";
import { RunsController } from "./runs.controller.js";
import { TrackingController } from "./tracking.controller.js";
import { TrackingModule } from "./tracking.module.js";

// STORY-022's compiles-test, extended by STORY-034. The module now imports
// CacheModule, which validates the full env schema at `.compile()` time, so
// this needs the same env fixture every other composition-root spec uses —
// the treatment PromptsModule's spec already documents.
describe("STORY-022 · TrackingModule compiles", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TrackingModule] }).compile();
    expect(moduleRef.get(TrackingController)).toBeInstanceOf(TrackingController);
    expect(moduleRef.get(RunsController)).toBeInstanceOf(RunsController);
    expect(moduleRef.get(MatrixController)).toBeInstanceOf(MatrixController);
    expect(moduleRef.get(RunEstimateService)).toBeInstanceOf(RunEstimateService);
    expect(moduleRef.get(RunLifecycleService)).toBeInstanceOf(RunLifecycleService);
    await moduleRef.close();
  });
});
