import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AgencyModule } from "./agency.module.js";
import { AgencyController } from "./agency.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · AgencyModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AgencyModule] }).compile();
    expect(moduleRef.get(AgencyController)).toBeInstanceOf(AgencyController);
    await moduleRef.close();
  });
});
