import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { GeminiNaturaliser } from "./adapters/gemini-naturaliser.js";
import { PROMPT_NATURALISER } from "./ports/naturaliser.js";
import { PromptActivationService } from "./activation.service.js";
import { PromptLifecycleController } from "./lifecycle.controller.js";
import { PromptLifecycleService } from "./lifecycle.service.js";
import { PromptListService } from "./prompt-list.service.js";
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

  it("binds NO naturaliser by default — §4's template_only path stays the live one", async () => {
    // PROMPT_NATURALISER defaults to `none` (owner decision 2026-10-28 #3, STORY-045 AC3): the token resolves, to null, so the service still runs
    // the deterministic template-only path unless configuration says otherwise.
    delete process.env.PROMPT_NATURALISER;
    const moduleRef = await Test.createTestingModule({ imports: [PromptsModule] }).compile();
    expect(moduleRef.get(PromptsService)).toBeInstanceOf(PromptsService);
    expect(moduleRef.get(PROMPT_NATURALISER)).toBeNull();
    await moduleRef.close();
  });

  it("binds the Gemini naturaliser when PROMPT_NATURALISER=gemini and a key is configured", async () => {
    process.env.PROMPT_NATURALISER = "gemini";
    process.env.GEMINI_API_KEY = "fake-key-never-used";
    const moduleRef = await Test.createTestingModule({ imports: [PromptsModule] }).compile();
    expect(moduleRef.get(PROMPT_NATURALISER)).toBeInstanceOf(GeminiNaturaliser);
    await moduleRef.close();
  });

  it("resolves both controllers and every service", async () => {
    // STORY-046 added the activation and lifecycle halves. Asserted here
    // because a service that compiles but is not PROVIDED fails only at the
    // first request, and this module's spec is the cheapest place to find it.
    const moduleRef = await Test.createTestingModule({ imports: [PromptsModule] }).compile();
    expect(moduleRef.get(PromptsController)).toBeInstanceOf(PromptsController);
    expect(moduleRef.get(PromptLifecycleController)).toBeInstanceOf(PromptLifecycleController);
    expect(moduleRef.get(PromptActivationService)).toBeInstanceOf(PromptActivationService);
    expect(moduleRef.get(PromptLifecycleService)).toBeInstanceOf(PromptLifecycleService);
    // STORY-134's list/create half. A service that compiles but is not
    // PROVIDED fails only at the first request.
    expect(moduleRef.get(PromptListService)).toBeInstanceOf(PromptListService);
    await moduleRef.close();
  });
});
