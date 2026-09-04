import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectsModule } from "./projects.module.js";
import { ProjectsController } from "./projects.controller.js";
import { ProjectsService } from "./projects.service.js";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";

// STORY-022 — one compiles-test per scaffolded module.
//
// STORY-043 added the env fixture. ProjectsModule now imports
// QueueProducerModule, whose factories read the environment at .compile()
// time to build the Redis connection and the job-signing keys — the same
// reason EntitlementsModule's spec has one.
describe("STORY-022 · ProjectsModule compiles", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProjectsModule] }).compile();
    expect(moduleRef.get(ProjectsController)).toBeInstanceOf(ProjectsController);
    await moduleRef.close();
  });

  // STORY-043 — the service takes three collaborators, two of them from
  // OTHER modules. If either import is dropped the application fails to boot,
  // and a compiles-test that only reached the controller would not notice.
  it("resolves the service with its queue producer and entitlement resolver", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProjectsModule] }).compile();
    expect(moduleRef.get(ProjectsService)).toBeInstanceOf(ProjectsService);
    await moduleRef.close();
  });
});
