import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { IntegrationsModule } from "./integrations.module.js";
import { IntegrationsController } from "./integrations.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · IntegrationsModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [IntegrationsModule] }).compile();
    expect(moduleRef.get(IntegrationsController)).toBeInstanceOf(IntegrationsController);
    await moduleRef.close();
  });
});
