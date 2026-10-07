import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { RateLimitClass } from "../../api/rate-limit/route-class.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import { CommandService } from "./command.service.js";
import {
  commandParseRequestSchema,
  commandParseResponseSchema,
  type CommandParseRequest,
  type CommandParseResponse,
} from "./dto/index.js";

// STORY-085-A — thin HTTP surface (coding-standards.md §1). A parse is a
// read: no @Credits, no @Audit, no idempotency key — there is nothing to
// debit, record or replay. `workspace:read` because every role may ask what a
// phrase means; whether it may then DO it is execute's guard, and
// `actions[].required_permission` tells the client which.
@Controller("command")
export class CommandController {
  constructor(private readonly service: CommandService) {}

  @Post("parse")
  @HttpCode(200)
  @RequirePermission("workspace:read")
  @RateLimitClass("command_parse")
  @ApiContract({
    operationId: "parseCommand",
    requestSchema: commandParseRequestSchema,
    responseSchema: commandParseResponseSchema,
  })
  parse(
    @Req() req: RbacScopedRequest,
    @Body(new ZodValidationPipe(commandParseRequestSchema)) body: CommandParseRequest,
  ): Promise<CommandParseResponse> {
    return this.service.parse(req.tenant!.workspaceId, body.query);
  }
}
