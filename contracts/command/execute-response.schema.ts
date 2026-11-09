import { z } from "zod";
import { commandIntentSchema } from "./command-intent.schema.js";

// STORY-085 (decisions 78c, 79) — what POST /v1/command/execute answers.
//
// Two outcomes and no third. `executed`: the server ran the action (a deep scan or a
// task - the only two the bar executes) and `resource` names what it made.
// `open_screen`: the action is one the client finishes on its own screen (a tool run,
// a new project, an invitation), so the server wrote and spent nothing and returns the
// screen and its prefill. `resource` and `target` are each null on the other outcome.

export const COMMAND_SCREENS = [
  "tools.visibility_scan",
  "tools.prompt_research",
  "tools.competitor_finder",
  "tools.aux_audit",
  "projects.new",
  "members.invite",
  "reports.new",
] as const;
export const commandScreenSchema = z.enum(COMMAND_SCREENS);
export type CommandScreen = z.infer<typeof commandScreenSchema>;

export const commandExecutedResourceSchema = z
  .object({
    type: z.enum(["run", "task"]),
    id: z.uuid(),
  })
  .strict();

export const commandOpenTargetSchema = z
  .object({
    screen: commandScreenSchema,
    /** Text and ids the screen opens with. Never a credential; the user typed or chose every value. */
    prefill: z.record(z.string(), z.string()),
  })
  .strict();

export const commandExecuteResponseSchema = z
  .object({
    outcome: z.enum(["executed", "open_screen"]),
    intent: commandIntentSchema,
    resource: commandExecutedResourceSchema.nullable(),
    target: commandOpenTargetSchema.nullable(),
    /** What the action debited; 0 for anything free and for every open_screen outcome. */
    credits_charged: z.number().int().min(0),
  })
  .strict();

export type CommandExecuteResponse = z.infer<typeof commandExecuteResponseSchema>;
