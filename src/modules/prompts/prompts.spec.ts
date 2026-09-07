import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { PROMPT_NATURALISER } from "./ports/naturaliser.js";
import { PromptsController } from "./prompts.controller.js";
import { PromptsModule } from "./prompts.module.js";
import { PromptsService } from "./prompts.service.js";

// STORY-022's compiles-test, extended by STORY-045. The module now imports
// CacheModule, which validates the full env schema at .compile() time, so
// this needs the same env fixture every other composition-root spec uses —
// the treatment EntitlementsModule's spec already documents.
describe("STORY-022 · PromptsModule compiles", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PromptsModule] }).compile();
    expect(moduleRef.get(PromptsController)).toBeInstanceOf(PromptsController);
    await moduleRef.close();
  });

  it("resolves the service with NO naturaliser bound — §4's template_only path", async () => {
    // STORY-045's actual state, asserted rather than described. Which model
    // naturalises prompt text is a dependency decision that
    // development-workflow.md §6 puts outside what an agent may decide, so
    // the port is declared and nothing binds it. If a provider is bound
    // later this test should be updated, not deleted: it is the thing that
    // says the template-only path is the live one.
    const moduleRef = await Test.createTestingModule({ imports: [PromptsModule] }).compile();
    expect(moduleRef.get(PromptsService)).toBeInstanceOf(PromptsService);
    expect(() => moduleRef.get(PROMPT_NATURALISER)).toThrow();
    await moduleRef.close();
  });
});
