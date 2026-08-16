import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { IdentityModule } from "./identity.module.js";
import { IdentityController } from "./identity.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · IdentityModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [IdentityModule] }).compile();
    expect(moduleRef.get(IdentityController)).toBeInstanceOf(IdentityController);
    await moduleRef.close();
  });
});
