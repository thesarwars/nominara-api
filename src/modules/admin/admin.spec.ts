import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AdminModule } from "./admin.module.js";
import { AdminController } from "./admin.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · AdminModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AdminModule] }).compile();
    expect(moduleRef.get(AdminController)).toBeInstanceOf(AdminController);
    await moduleRef.close();
  });
});
