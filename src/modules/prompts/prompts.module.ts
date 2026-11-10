import { Module } from "@nestjs/common";
import { QueueProducerModule } from "../../lib/queue/queue-producer.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { PromptActivationService } from "./activation.service.js";
import { PromptLifecycleController } from "./lifecycle.controller.js";
import { PromptLifecycleService } from "./lifecycle.service.js";
import { PromptListService } from "./prompt-list.service.js";
import { PromptsController } from "./prompts.controller.js";
import { PromptsService } from "./prompts.service.js";
import { TopicsController } from "./topics.controller.js";
import { TopicsService } from "./topics.service.js";

// STORY-045 — the prompts bounded area.
//
// GENERATION (owner decision 95(a), 2026-11-10). `POST /prompts/generate` only records a pending generation and enqueues `prompt.generate`
// (QueueProducerModule), so this module binds no naturaliser, embedder or cache: the model call and vector dedupe run in the job, outside any
// transaction (src/lib/queue/handlers/prompt-generate.handler.ts).
//
// EntitlementsModule is imported for its EntitlementResolver, which is what
// binds the prompt cap at activation. STORY-046's whole point is that "caps
// bind at activation, not at generation", so this module cannot resolve one
// without it.
// QueueProducerModule: the inline activation debit asks for an auto top-up after it commits (NEW-D-7), which is a
// queue job. The producer is @Optional in both services, so a process without one still charges.
@Module({
  imports: [EntitlementsModule, QueueProducerModule],
  controllers: [PromptsController, PromptLifecycleController, TopicsController],
  providers: [PromptsService, PromptActivationService, PromptLifecycleService, PromptListService, TopicsService],
})
export class PromptsModule {}
