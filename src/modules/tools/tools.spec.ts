import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { ToolsController } from "./tools.controller.js";
import { ToolsModule } from "./tools.module.js";
import { ToolsService } from "./tools.service.js";

// STORY-022 - one compiles-test per scaffolded module.
//
// STORY-078 gave ToolsModule real collaborators (ProjectsModule -> QueueProducerModule, EntitlementsModule), whose factories read the
// environment at .compile() time - hence the env fixture, as in projects.spec.ts.
describe("STORY-022 · ToolsModule compiles", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ToolsModule] }).compile();
    expect(moduleRef.get(ToolsController)).toBeInstanceOf(ToolsController);
    expect(moduleRef.get(ToolsService)).toBeInstanceOf(ToolsService);
    await moduleRef.close();
  });
});
