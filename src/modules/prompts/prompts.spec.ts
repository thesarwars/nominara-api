import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { PromptsModule } from "./prompts.module.js";
import { PromptsController } from "./prompts.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · PromptsModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PromptsModule] }).compile();
    expect(moduleRef.get(PromptsController)).toBeInstanceOf(PromptsController);
    await moduleRef.close();
  });
});
