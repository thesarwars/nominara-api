import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { CreditsFromCommandParse } from "../../api/decorators/credits.decorator.js";
import { Idempotent } from "../../api/decorators/idempotent.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { RateLimitClass } from "../../api/rate-limit/route-class.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import type { CreditUsage } from "../../api/interceptors/credit.interceptor.js";
import type { CommandCaller } from "./command-caller.js";
import { CommandExecuteService } from "./command-execute.service.js";
import { CommandService } from "./command.service.js";
import { EntityIndexService } from "./entity-index.service.js";
import {
  commandExecuteRequestSchema,
  commandExecuteResponseSchema,
  commandParseRequestSchema,
  commandParseResponseSchema,
  entityIndexResponseSchema,
  type CommandExecuteRequest,
  type CommandExecuteResponse,
  type CommandParseRequest,
  type CommandParseResponse,
  type EntityIndexResponse,
} from "./dto/index.js";

// STORY-085-A - thin HTTP surface (coding-standards.md section 1). A parse is a
// read: no @Credits, no idempotency key - there is nothing to debit or replay.
// It IS @Audit()ed: AuditInterceptor fails closed on any POST without audit
// metadata (the same finding as `POST runs/estimate`), so an unaudited parse
// answers 500. The audit row is the ONLY row a parse writes - "never mutates"
// means no domain state, no credits, no queue - and it records the OUTCOME
// only (intent, resolved_by, cached, confidence): the response's `slots` are
// verbatim customer text and never reach audit_log. The resource is the
// workspace itself. `workspace:read` because every role may ask what a phrase means; whether it may then DO it is execute's guard, and
// `actions[].required_permission` tells the client which.
@Controller("command")
export class CommandController {
  constructor(
    private readonly service: CommandService,
    private readonly index: EntityIndexService,
    private readonly executor: CommandExecuteService,
  ) {}

  // STORY-085 AC2/AC3 - the bounded, prefetched index. A read (default `reads` class), free, no audit row: GET.
  // Scoped and gated inside the service by RLS and `app.current_scope_projects()`, so a scoped manager's index is their own.
  @Get("entities")
  @RequirePermission("workspace:read")
  @ApiContract({ operationId: "listCommandEntities", responseSchema: entityIndexResponseSchema })
  entities(@Req() req: RbacScopedRequest): Promise<EntityIndexResponse> {
    return this.index.read(callerOf(req));
  }

  @Post("parse")
  @HttpCode(200)
  @RequirePermission("workspace:read")
  @RateLimitClass("command_parse")
  @Audit({
    action: "command.parsed",
    resourceType: "workspace",
    resourceIdFrom: "workspace",
    afterState: (body) => {
      const { intent, resolved_by, cached, confidence } = body as CommandParseResponse;
      return { intent, resolved_by, cached, confidence };
    },
  })
  @ApiContract({
    operationId: "parseCommand",
    requestSchema: commandParseRequestSchema,
    responseSchema: commandParseResponseSchema,
  })
  parse(
    @Req() req: RbacScopedRequest,
    @Body(new ZodValidationPipe(commandParseRequestSchema)) body: CommandParseRequest,
  ): Promise<CommandParseResponse> {
    return this.service.parse(callerOf(req), body.query);
  }

  // STORY-085 (decisions 78c, 79) - the separate execute endpoint. `workspace:read` is only the floor: the
  // permission of the UNDERLYING action is evaluated against the live role by `CreditGuard`'s parse-record
  // resolution (before anything is reserved) and again in the service. `@CreditsFromCommandParse()` makes the
  // confirmed-credits header mandatory for a priced action and is the guard's own confirm-and-reserve path.
  // `@Idempotent()`: a retried request replays its first answer and never re-spends a parse id.
  @Post("execute")
  @HttpCode(200)
  @Idempotent()
  @RequirePermission("workspace:read")
  @RateLimitClass("command_execute")
  @CreditsFromCommandParse()
  // The audit row records the ORIGIN (AC19): the command bar, the intent and the outcome. Never the typed text.
  @Audit({
    action: "command.executed",
    resourceType: "workspace",
    resourceIdFrom: "workspace",
    afterState: (body) => {
      const { intent, outcome, resource, credits_charged } = body as CommandExecuteResponse;
      return { origin: "command_bar", intent, outcome, resource, credits_charged };
    },
  })
  @ApiContract({
    operationId: "executeCommand",
    requestSchema: commandExecuteRequestSchema,
    responseSchema: commandExecuteResponseSchema,
    requiresIdempotencyKey: true,
  })
  async execute(
    @Req() req: RbacScopedRequest & { creditUsage?: CreditUsage },
    @Body(new ZodValidationPipe(commandExecuteRequestSchema)) body: CommandExecuteRequest,
  ): Promise<CommandExecuteResponse> {
    const { response, usage } = await this.executor.execute(callerOf(req), body);
    // What CreditInterceptor records on the debit, as the underlying trigger route stamps it.
    if (usage !== undefined) req.creditUsage = usage;
    return response;
  }
}

function callerOf(req: RbacScopedRequest): CommandCaller {
  const tenant = req.tenant;
  if (tenant === undefined) throw new Error("the command routes have no tenant context: WorkspaceGuard did not run");
  return {
    workspaceId: tenant.workspaceId,
    actorId: tenant.actorId,
    membership: req.membership,
    lastStrongAuthAt: req.session?.lastStrongAuthAt ?? null,
  };
}
