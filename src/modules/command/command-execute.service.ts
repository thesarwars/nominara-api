import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { CommandExecuteRequest } from "../../../contracts/command/execute-request.schema.js";
import type { CommandExecuteResponse } from "../../../contracts/command/execute-response.schema.js";
import { createTaskRequestSchema } from "../../../contracts/tasks/create-task-request.schema.js";
import { ConflictError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import type { CreditUsage } from "../../api/interceptors/credit.interceptor.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { assertMayExecute } from "../../lib/command/execute-access.js";
import { consumeParseRecord, peekParseRecord, type ParseRecord } from "../../lib/command/parse-record.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { TasksService } from "../tasks/tasks.service.js";
import { RunLifecycleService } from "../tracking/run-lifecycle.service.js";
import type { CommandCaller } from "./command-caller.js";
import { ACTIONS } from "./command-grammar.js";

// STORY-085 (decisions 78c, 79) - POST /v1/command/execute. A class of its own so that `CommandService` (the parse)
// cannot reach the two services that write: the run lifecycle and the tasks service live ONLY here.
//
// Runs a deep scan or creates a task, through the same owning services the underlying routes call, in the same
// request transaction. Every other mutating intent (tool runs, create project, invite, build report) returns the
// screen to open, prefilled: the bar never executes them and never spends for them.

const tracer = trace.getTracer("nominara-api");

@Injectable()
export class CommandExecuteService {
  private readonly logger = new Logger(CommandExecuteService.name);

  constructor(
    @Inject(CACHE) private readonly cache: Cache,
    private readonly runs: RunLifecycleService,
    private readonly tasks: TasksService,
  ) {}

  /**
   * POST /command/execute. By the time this runs, `CreditGuard` has already confirmed the price and reserved
   * (a deep scan) and refused a forbidden action; it is re-checked here as the backstop, and the parse id is
   * CONSUMED here - atomically, so of any number of concurrent presentations exactly one proceeds.
   */
  async execute(
    caller: CommandCaller,
    request: CommandExecuteRequest,
  ): Promise<{ readonly response: CommandExecuteResponse; readonly usage: CreditUsage | undefined }> {
    return await tracer.startActiveSpan("command.execute", async (span) => {
      try {
        span.setAttributes({ "nominara.workspace_id": caller.workspaceId });
        const read = await peekParseRecord(this.cache, cacheKeyNamespace(), request.parse_id, {
          workspaceId: caller.workspaceId,
          actorId: caller.actorId,
          actionId: request.action_id,
        });
        if (!read.ok) {
          incrementCounter("nominara_command_execute_total", { intent: "none", outcome: `refused_${read.reason}` });
          if (read.reason === "wrong_action") {
            throw new ValidationFailedError({
              message: "action_id is not the action this parse offered",
              details: { issues: [{ path: ["action_id"], message: "does not match the parse" }] },
            });
          }
          // An expired id, a used id and another user's id are one answer: no oracle on which.
          throw new ConflictError({ message: "this parse id is unknown, expired or already used; parse again" });
        }
        const record = read.record;
        span.setAttributes({ "nominara.command.intent": record.intent });

        if (record.handling === "client") {
          // Answered in the browser. Refused BEFORE the consume so a stray click does not burn the id.
          throw new ValidationFailedError({
            message: "this action has no server-side execution",
            details: { issues: [{ path: ["action_id"], message: "resolved by the client; nothing to execute" }] },
          });
        }

        if (record.project_id !== null && request.project_id !== undefined && request.project_id !== record.project_id) {
          throw new ValidationFailedError({
            message: "project_id disagrees with the project the parse bound",
            details: { issues: [{ path: ["project_id"], message: "differs from the bound project" }] },
          });
        }
        const projectId = record.project_id ?? request.project_id ?? null;
        assertMayExecute(record, caller.membership, projectId, caller.lastStrongAuthAt);

        // Validate everything that can be refused BEFORE the id is spent: a refusal must not burn it.
        let title: string | undefined;
        if (record.intent === "create_task") {
          if (projectId === null) throw needsProject();
          const typed = createTaskRequestSchema.safeParse({ title: record.slots["title"] });
          if (!typed.success) {
            throw new ValidationFailedError({
              message: "a task needs a title",
              details: { issues: [{ path: ["title"], message: "the command named no usable task title" }] },
            });
          }
          title = typed.data.title;
        }
        if (record.intent === "run_deep_scan" && projectId === null) throw needsProject();

        if (!(await consumeParseRecord(this.cache, read))) {
          incrementCounter("nominara_command_execute_total", { intent: record.intent, outcome: "refused_unknown_or_used" });
          throw new ConflictError({ message: "this parse id is unknown, expired or already used; parse again" });
        }

        const result = await this.run(caller, record, projectId, title);
        incrementCounter("nominara_command_execute_total", { intent: record.intent, outcome: result.response.outcome });
        this.logger.log({ event: "command.execute", workspace_id: caller.workspaceId, intent: record.intent, outcome: result.response.outcome });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async run(
    caller: CommandCaller,
    record: ParseRecord,
    projectId: string | null,
    title: string | undefined,
  ): Promise<{ readonly response: CommandExecuteResponse; readonly usage: CreditUsage | undefined }> {
    if (record.handling === "open_screen") {
      const spec = ACTIONS[record.intent];
      const prefill: Record<string, string> = {};
      for (const [slot, key] of Object.entries(spec.prefill ?? {})) {
        const value = slot === "project" ? (record.project_name ?? record.slots[slot]) : record.slots[slot];
        if (value !== undefined) prefill[key] = value;
      }
      if (projectId !== null) prefill["project_id"] = projectId;
      return {
        response: { outcome: "open_screen", intent: record.intent, resource: null, target: { screen: spec.screen!, prefill }, credits_charged: 0 },
        usage: undefined,
      };
    }

    if (record.intent === "run_deep_scan") {
      // The same service the underlying route calls, in the same request transaction: no second implementation.
      const { progress, usage } = await this.runs.trigger(projectId!, caller.actorId);
      return {
        response: {
          outcome: "executed",
          intent: record.intent,
          resource: { type: "run", id: progress.run_id },
          target: null,
          // The flat price the credit guard reserved and the interceptor commits for this run. `charge.charged` is NOT used: the
          // lifecycle presents it before settlement, so it reads false on a scan that is about to be debited in full.
          credits_charged: progress.charge?.credits ?? 0,
        },
        usage,
      };
    }

    const task = await this.tasks.createTask(projectId!, { title: title! });
    return {
      response: { outcome: "executed", intent: record.intent, resource: { type: "task", id: task.id }, target: null, credits_charged: 0 },
      usage: undefined,
    };
  }
}

function needsProject(): InstanceType<typeof ValidationFailedError> {
  return new ValidationFailedError({
    message: "this action needs a project",
    details: { issues: [{ path: ["project_id"], message: "the parse bound no project; send project_id" }] },
  });
}
