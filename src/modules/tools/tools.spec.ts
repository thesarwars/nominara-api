import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { ToolsModule } from "./tools.module.js";
import { ToolsController } from "./tools.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · ToolsModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ToolsModule] }).compile();
    expect(moduleRef.get(ToolsController)).toBeInstanceOf(ToolsController);
    await moduleRef.close();
  });
});
