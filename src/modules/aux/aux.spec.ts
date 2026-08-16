import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AuxModule } from "./aux.module.js";
import { AuxController } from "./aux.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · AuxModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuxModule] }).compile();
    expect(moduleRef.get(AuxController)).toBeInstanceOf(AuxController);
    await moduleRef.close();
  });
});
