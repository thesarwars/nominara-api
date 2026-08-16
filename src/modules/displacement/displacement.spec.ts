import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { DisplacementModule } from "./displacement.module.js";
import { DisplacementController } from "./displacement.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · DisplacementModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DisplacementModule] }).compile();
    expect(moduleRef.get(DisplacementController)).toBeInstanceOf(DisplacementController);
    await moduleRef.close();
  });
});
