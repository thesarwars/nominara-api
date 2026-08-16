import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { ProjectsModule } from "./projects.module.js";
import { ProjectsController } from "./projects.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · ProjectsModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProjectsModule] }).compile();
    expect(moduleRef.get(ProjectsController)).toBeInstanceOf(ProjectsController);
    await moduleRef.close();
  });
});
