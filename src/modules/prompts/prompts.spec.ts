import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { PROMPT_NATURALISER } from "./ports/naturaliser.js";
import { PromptActivationService } from "./activation.service.js";
import { PromptLifecycleController } from "./lifecycle.controller.js";
import { PromptLifecycleService } from "./lifecycle.service.js";
import { PromptListService } from "./prompt-list.service.js";
import { PromptsController } from "./prompts.controller.js";
import { PromptsModule } from "./prompts.module.js";
import { PromptsService } from "./prompts.service.js";

// STORY-022's compiles-test, extended by STORY-045. The module imports
// EntitlementsModule, whose cache dependency validates the full env schema at
// .compile() time, so this needs the same env fixture every other
// composition-root spec uses — the treatment EntitlementsModule's spec
// already documents.
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

  it("STORY-045 decision 95(a) - binds no naturaliser and no embedder: the request path cannot call either, the prompt.generate job does", async () => {
    // The route only records a pending generation and enqueues. PROMPT_NATURALISER=gemini is read by the job (selectNaturaliser), so setting it
    // changes nothing about what this module provides - and the service takes no provider through its constructor at all.
    process.env.PROMPT_NATURALISER = "gemini";
    process.env.GEMINI_API_KEY = "fake-key-never-used";
    const moduleRef = await Test.createTestingModule({ imports: [PromptsModule] }).compile();
    expect(moduleRef.get(PromptsService)).toBeInstanceOf(PromptsService);
    expect(() => moduleRef.get(PROMPT_NATURALISER)).toThrow();
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
