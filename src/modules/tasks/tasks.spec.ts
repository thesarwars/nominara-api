import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { TasksModule } from "./tasks.module.js";
import { TasksController } from "./tasks.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · TasksModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TasksModule] }).compile();
    expect(moduleRef.get(TasksController)).toBeInstanceOf(TasksController);
    await moduleRef.close();
  });
});
