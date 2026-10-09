import { z } from "zod";

// STORY-085-A — product-spec.md §13 FR-NL-03: "Canonical intent list — the
// ONLY place it is enumerated ... Every other document references this list
// rather than restating a count."
//
// This tuple is the codebase's one enumeration. The server grammar derives
// from it (`Record<CommandIntent, ...>` makes a missing or extra member a
// compile error) and the response schema below derives from it. Nothing
// restates how many there are: a count written down anywhere else is a second
// definition that drifts, which is what test/unit/command-intent-single-source
// exists to catch.
//
// `unresolved` is NOT a member. It is the absence of an intent, never a
// fifteenth action: there is no open-ended agent (FR-NL-03), so input that
// matches nothing yields no action at all.
export const COMMAND_INTENTS = [
  "filter_find",
  "compare",
  "navigate",
  "run_visibility_scan",
  "run_prompt_research",
  "run_competitor_finder",
  "run_aux_audit",
  "run_deep_scan",
  "create_project",
  "create_task",
  "show_tasks",
  "build_report",
  "explain_metric",
  "invite_member",
] as const;

export const commandIntentSchema = z.enum(COMMAND_INTENTS);
export type CommandIntent = z.infer<typeof commandIntentSchema>;

/** What a parse reports when no intent matched, or more than one did. */
export const UNRESOLVED_INTENT = "unresolved" as const;
