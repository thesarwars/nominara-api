import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { CommandModule } from "./command.module.js";
import { CommandController } from "./command.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · CommandModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CommandModule] }).compile();
    expect(moduleRef.get(CommandController)).toBeInstanceOf(CommandController);
    await moduleRef.close();
  });
});
