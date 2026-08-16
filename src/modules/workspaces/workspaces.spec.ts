import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { WorkspacesModule } from "./workspaces.module.js";
import { WorkspacesController } from "./workspaces.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · WorkspacesModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkspacesModule] }).compile();
    expect(moduleRef.get(WorkspacesController)).toBeInstanceOf(WorkspacesController);
    await moduleRef.close();
  });
});
