import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { EntitlementsModule } from "./entitlements.module.js";
import { EntitlementsController } from "./entitlements.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · EntitlementsModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EntitlementsModule] }).compile();
    expect(moduleRef.get(EntitlementsController)).toBeInstanceOf(EntitlementsController);
    await moduleRef.close();
  });
});
