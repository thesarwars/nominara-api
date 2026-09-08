import { Body, Controller, Param, Patch } from "@nestjs/common";
import {
  promptResponseSchema,
  updatePromptRequestSchema,
  type PromptResponse,
  type UpdatePromptRequest,
} from "../../../contracts/prompts/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { PromptLifecycleService } from "./lifecycle.service.js";

// STORY-046 — `PATCH /v1/prompts/{id}`. api-specification.md §3:
// "pause/resume, priority flag, edit text (re-hashes and starts a new
// series)".
//
// A SEPARATE CONTROLLER because the route is TOP-LEVEL, not nested under the
// project. §3 puts it there and it is the right shape: a prompt id is
// globally unique and its project is implied by the row, so requiring the
// project in the path would let a caller name a mismatched pair and need a
// fourth error for it. RLS scopes the tenant; the row's own `project_id` is
// the authority on which project it belongs to.
@Controller("prompts")
export class PromptLifecycleController {
  constructor(private readonly lifecycle: PromptLifecycleService) {}

  // NO `@Idempotent()`. §3 marks `POST .../activate` with `✚` and this route
  // with nothing, and the difference is real rather than an oversight: a PATCH
  // setting a status or a flag is naturally idempotent, and the edit path is
  // not — replaying an edit with the same body is a NO-OP by construction,
  // because identical text is compared on the normalised hash and supersedes
  // nothing. An idempotency key here would add a store round trip to protect
  // against a double effect that cannot happen.
  //
  // NO `@RequireEntitlement` either, for the reason the activate route
  // records at length: `wouldExceed` is `current >= limit`, so the guard
  // would refuse a project AT its cap regardless of what the request does —
  // including PAUSING, ARCHIVING or CLEARING a priority flag, which are the
  // three actions that get a customer back under their cap. The service binds
  // the cap only on the transition that actually takes a slot (leaving
  // `archived`), which is the check that can tell those apart.
  @Patch(":id")
  @RequirePermission("prompt:write")
  // Audited because all three changes alter the measurement: pausing stops
  // capturing a question, archiving removes it, and an edit starts a new
  // history series whose numbers are not comparable to the old one's.
  @Audit({ action: "prompt.updated", resourceType: "prompt" })
  @ApiContract({
    operationId: "updatePrompt",
    requestSchema: updatePromptRequestSchema,
    responseSchema: promptResponseSchema,
  })
  update(
    @Param("id") promptId: string,
    @Body(new ZodValidationPipe(updatePromptRequestSchema)) body: UpdatePromptRequest,
  ): Promise<PromptResponse> {
    return this.lifecycle.update(promptId, body);
  }
}
