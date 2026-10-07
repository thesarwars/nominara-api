import { Module } from "@nestjs/common";
import { CacheModule } from "../../lib/cache/cache.module.js";
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
// NO NATURALISER PROVIDER. `PROMPT_NATURALISER` is declared as a port
// (./ports/naturaliser.ts) and nothing binds it, so PromptsService receives
// null and every pass runs §4's `template_only` path. That is deliberate:
// which model naturalises prompt text is a dependency decision, and
// development-workflow.md §6 puts adding a dependency outside what an agent
// may decide. Binding a provider here is the last step of STORY-045, and it
// needs the two answers the port's own file sets out — whether the call may
// sit on the request path, and which metric absorbs its cost.
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
@Module({
  imports: [CacheModule, EntitlementsModule],
  controllers: [PromptsController, PromptLifecycleController, TopicsController],
  providers: [PromptsService, PromptActivationService, PromptLifecycleService, PromptListService, TopicsService],
})
export class PromptsModule {}
