import { Body, Controller, HttpCode, Param, Post, Req } from "@nestjs/common";
import {
  activatePromptsRequestSchema,
  activatePromptsResponseSchema,
  generatePromptsRequestSchema,
  generatePromptsResponseSchema,
  type ActivatePromptsRequest,
  type ActivatePromptsResponse,
  type GeneratePromptsRequest,
  type GeneratePromptsResponse,
} from "../../../contracts/prompts/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { PromptActivationService } from "./activation.service.js";
import { PromptsService } from "./prompts.service.js";

// STORY-045 — api-specification.md §5. A controller resolves the request,
// calls one service method, and returns (coding-standards.md §1).
//
// NESTED UNDER `projects`, because §3's route is
// `POST /projects/{id}/prompts/generate` and the prompt belongs to the
// project directly — `schemas/projects-and-prompts.md`: "Prompts belong to
// the PROJECT directly. There is no 'seed keyword' step."
//
// The parameter is `:id`, not `:projectId`. §3 writes `{id}` and every other
// nested route in the generated document uses it — `/projects/{id}/discovery`,
// `/workspaces/{id}/invitations`. A single route spelling it differently
// shows up as a differently-named argument in the published client for no
// reason a caller could infer. Caught by reading the regenerated document
// rather than by a test.
@Controller("projects/:id/prompts")
export class PromptsController {
  constructor(
    private readonly service: PromptsService,
    private readonly activation: PromptActivationService,
  ) {}

  // 200, not 202. §5's response carries `variants[]` — the prompts exist and
  // are readable the moment it returns, unlike project creation where
  // discovery is still running behind a 202.
  //
  // NO `@RequireEntitlement`, and that is FR-FAN-01g rather than an omission:
  // "Generation is never capped by packaging. All 15 variants are produced
  // and persisted; the plan's cap binds only at ACTIVATION." Every row lands
  // `archived`, which `PROMPT_OCCUPIES_SLOT` excludes, so a pass consumes no
  // plan capacity at all. §3's route table marks activate with `⛨ ¢` and
  // generate with neither.
  @Post("generate")
  @HttpCode(200)
  // §3 marks this route `✚` — the interceptor refuses a missing key with a
  // 400 before validation runs. A pass writes fifteen rows, so a retried
  // submission must replay rather than double them.
  @Idempotent()
  @RequirePermission("prompt:write")
  // Audited because a pass writes fifteen rows that shape every subsequent
  // measurement: which questions the engines are asked IS the measurement,
  // and a changed prompt set changes the meaning of every number after it.
  @Audit({ action: "prompt.generated", resourceType: "project" })
  @ApiContract({
    operationId: "generatePrompts",
    requestSchema: generatePromptsRequestSchema,
    responseSchema: generatePromptsResponseSchema,
  })
  generate(
    @Req() _req: RbacScopedRequest,
    @Param("id") projectId: string,
    @Body(new ZodValidationPipe(generatePromptsRequestSchema)) body: GeneratePromptsRequest,
  ): Promise<GeneratePromptsResponse> {
    return this.service.generate(projectId, body);
  }

  // STORY-046 — §3: "activate a chosen subset; `403 entitlement_exceeded`
  // names the remaining slots." plans-and-entitlements.md §10.
  //
  // *** NO `@RequireEntitlement("prompts.max_per_project")`, AND THAT IS A
  //     DECISION RATHER THAN AN OMISSION. ***
  //
  // §3 marks this route with the entitlement glyph, and the obvious way to
  // honour that is the decorator. It would be wrong here. `wouldExceed` is
  // `current >= limit` — the guard refuses whenever the project is AT its
  // cap, without knowing what the request contains. So a REPLAY of a
  // successful activation, where every named prompt is already active and
  // nothing new is being taken, would be refused with a 403 at the cap.
  //
  // AC12 requires activation to be idempotent under replay, and an idempotent
  // endpoint that fails its own retry is worse than one that never claimed to
  // be. The cap is therefore bound in the service, where the arithmetic
  // (`activeBefore + toActivate > cap`) can see that an already-active prompt
  // takes no slot. The refusal it raises is the same
  // `403 entitlement_exceeded` with the same `{key, limit, current}` details
  // and the same `increase_limit` remediation, so the wire behaviour §3
  // describes is unchanged.
  @Post("activate")
  @HttpCode(200)
  // §3 marks it `✚`. A pass activates many rows; a retried submission must
  // replay rather than double-count, which is also what makes the
  // `already_active` summary member meaningful.
  @Idempotent()
  @RequirePermission("prompt:write")
  // Audited because activation is what decides which questions the engines
  // are actually asked — the prompt set IS the measurement, and a change to
  // it changes the meaning of every number after it.
  @Audit({ action: "prompt.activated", resourceType: "project" })
  @ApiContract({
    operationId: "activatePrompts",
    requestSchema: activatePromptsRequestSchema,
    responseSchema: activatePromptsResponseSchema,
  })
  activate(
    @Param("id") projectId: string,
    @Body(new ZodValidationPipe(activatePromptsRequestSchema)) body: ActivatePromptsRequest,
  ): Promise<ActivatePromptsResponse> {
    return this.activation.activate(projectId, body);
  }
}
