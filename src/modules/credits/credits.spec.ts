import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { CreditsModule } from "./credits.module.js";
import { CreditsController } from "./credits.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · CreditsModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CreditsModule] }).compile();
    expect(moduleRef.get(CreditsController)).toBeInstanceOf(CreditsController);
    await moduleRef.close();
  });
});
