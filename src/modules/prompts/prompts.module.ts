import { Module } from "@nestjs/common";
import { CacheModule } from "../../lib/cache/cache.module.js";
import { QueueProducerModule } from "../../lib/queue/queue-producer.module.js";
import { EntitlementsModule } from "../entitlements/entitlements.module.js";
import { loadEnv } from "../../config/env.js";
import { PromptActivationService } from "./activation.service.js";
import { PromptLifecycleController } from "./lifecycle.controller.js";
import { PromptLifecycleService } from "./lifecycle.service.js";
import { PromptListService } from "./prompt-list.service.js";
import { selectRequestPathNaturaliser } from "./naturaliser.selector.js";
import { PROMPT_NATURALISER } from "./ports/naturaliser.js";
import { PromptsController } from "./prompts.controller.js";
import { PromptsService } from "./prompts.service.js";
import { TopicsController } from "./topics.controller.js";
import { TopicsService } from "./topics.service.js";

// STORY-045 — the prompts bounded area.
//
// NATURALISER (owner decision 2026-10-28 #3). The Gemini adapter exists behind PROMPT_NATURALISER and is selectable by configuration
// (naturaliser.selector.ts), but it is deliberately NOT bound on the request path: this route's handler runs inside the ambient tenant
// transaction, so a bound adapter would await Gemini with that transaction open (ADR-0003 / NFR-ARCH-04), and the audit and idempotency
// interceptors write into the same transaction after the handler, so the route cannot simply step outside it. PROMPT_NATURALISER=gemini is
// therefore reported at boot and every pass runs the template-only path. Binding it needs STORY-045 decision #5 (enqueued generation read
// back by generation_batch_id, a contract change), which is the owner's. Before it is enabled it must also draw from the Gemini engine
// rate-limit bucket (GEMINI_REQUESTS_PER_MINUTE) and count against an engine spend ceiling, or it can starve capture runs.
//
// CacheModule is imported EXPLICITLY even though it is @Global(), following
// EntitlementsModule's precedent and for the reason its comment gives: a
// global module is only global once something has loaded it into the graph,
// so this module compiled on its own — as its own spec does — would have
// nothing to resolve CACHE from.
// EntitlementsModule is imported for its EntitlementResolver, which is what
// binds the prompt cap at activation. STORY-046's whole point is that "caps
// bind at activation, not at generation", so this module cannot resolve one
// without it.
// QueueProducerModule: the inline activation debit asks for an auto top-up after it commits (NEW-D-7), which is a
// queue job. The producer is @Optional in both services, so a process without one still charges.
@Module({
  imports: [CacheModule, EntitlementsModule, QueueProducerModule],
  controllers: [PromptsController, PromptLifecycleController, TopicsController],
  providers: [
    { provide: PROMPT_NATURALISER, useFactory: () => selectRequestPathNaturaliser(loadEnv()) },
    PromptsService, PromptActivationService, PromptLifecycleService, PromptListService, TopicsService],
})
export class PromptsModule {}
