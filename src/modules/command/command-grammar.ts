import {
  COMMAND_INTENTS,
  type CommandIntent,
} from "../../../contracts/command/command-intent.schema.js";
import type { CommandScreen } from "../../../contracts/command/execute-response.schema.js";
import type { z } from "zod";
import type { commandActionHandlingSchema } from "../../../contracts/command/parse-response.schema.js";

// STORY-085-A — the server grammar: deterministic, no model, no I/O.
//
// product-spec.md §13 FR-NL-01: a local grammar resolves the common cases at
// zero cost. This is that grammar's server half. It is a pure function of the
// normalised input; every property the story asserts about it (zero cost,
// never mutates) is therefore structural rather than a promise.
//
// `Record<CommandIntent, ...>` below makes the intent list the ONE source: an
// intent added to or removed from the contract is a compile error here until
// the grammar and the action table catch up. Nothing in this file counts them.

/** `confidence` per rule: an explicit verb scores higher than a bare one. A tie between DIFFERENT intents is ambiguity, never a coin-flip. */
interface Rule {
  readonly pattern: RegExp;
  readonly confidence: number;
  readonly slots: readonly string[];
}

export interface Match {
  readonly intent: CommandIntent;
  readonly confidence: number;
  readonly slots: Record<string, string>;
}

const OPTIONAL_TARGET = String.raw`(?: (?:on|for|in) (.+))?`;
const ROLES = "owner|admin|manager|analyst|viewer";
// Metrics a bare "what is ..." question may name. Without this list "what is
// the weather" would resolve to an intent; with it, only a question about a
// product metric does, and anything else is unresolved.
const METRICS = [
  "visibility score",
  "share of voice",
  "sentiment",
  "citation rate",
  "mention rate",
  "position in the answer",
  "aux score",
  "content score",
  "technical score",
  "authority score",
].join("|");

const RULES: Readonly<Record<CommandIntent, readonly Rule[]>> = {
  filter_find: [{ pattern: /^(?:filter|search(?: for)?|look up|find) (.+)$/, confidence: 0.7, slots: ["query"] }],
  compare: [{ pattern: /^compare (.+?) (?:with|and|to|versus|vs) (.+)$/, confidence: 0.95, slots: ["left", "right"] }],
  navigate: [{ pattern: /^(?:go to|open|navigate to|take me to|switch to) (?:the )?(.+)$/, confidence: 0.9, slots: ["target"] }],
  run_visibility_scan: [
    { pattern: new RegExp(String.raw`^(?:run|start) (?:a |the )?(?:visibility )?scan${OPTIONAL_TARGET}$`), confidence: 0.95, slots: ["project"] },
    { pattern: /^scan (.+)$/, confidence: 0.8, slots: ["project"] },
  ],
  run_prompt_research: [
    { pattern: new RegExp(String.raw`^(?:run|start) (?:a |the )?prompt research${OPTIONAL_TARGET}$`), confidence: 0.95, slots: ["project"] },
    { pattern: /^research prompts(?: (?:for|on) (.+))?$/, confidence: 0.95, slots: ["project"] },
  ],
  run_competitor_finder: [
    { pattern: new RegExp(String.raw`^(?:run|start) (?:a |the )?competitor (?:finder|discovery)${OPTIONAL_TARGET}$`), confidence: 0.95, slots: ["project"] },
    { pattern: /^find competitors(?: (?:for|on) (.+))?$/, confidence: 0.95, slots: ["project"] },
  ],
  run_aux_audit: [
    { pattern: new RegExp(String.raw`^(?:run|start) (?:an? |the )?aux audit${OPTIONAL_TARGET}$`), confidence: 0.95, slots: ["project"] },
    { pattern: /^audit (.+)$/, confidence: 0.8, slots: ["project"] },
  ],
  run_deep_scan: [
    { pattern: new RegExp(String.raw`^(?:run|start) (?:a |the )?deep scan${OPTIONAL_TARGET}$`), confidence: 0.95, slots: ["project"] },
  ],
  create_project: [
    { pattern: /^(?:create|add|start|new) (?:a |the )?(?:new )?project(?: (?:called|named) (.+))?$/, confidence: 0.95, slots: ["name"] },
    // A bare "create" names no object, so it is equally a project and a task.
    { pattern: /^(?:create|add|new)(?: new)?$/, confidence: 0.5, slots: [] },
  ],
  create_task: [
    { pattern: /^(?:create|add|new) (?:a |the )?(?:new )?task(?: (?:called|named|to|for) (.+))?$/, confidence: 0.95, slots: ["title"] },
    { pattern: /^(?:create|add|new)(?: new)?$/, confidence: 0.5, slots: [] },
  ],
  show_tasks: [
    { pattern: /^(?:show|list|view|find|what are) (?:me )?(?:my |all |the |open )*tasks(?: (?:for|in|on) (.+))?$/, confidence: 0.95, slots: ["project"] },
  ],
  build_report: [
    { pattern: /^(?:build|generate|create|make) (?:a |the )?report(?: (?:for|on) (.+))?$/, confidence: 0.95, slots: ["project"] },
  ],
  explain_metric: [
    { pattern: /^explain (?:the |my )?(.+?)(?: mean)?$/, confidence: 0.9, slots: ["metric"] },
    { pattern: new RegExp(String.raw`^(?:what is|what's|what does) (?:the |my )?(${METRICS})(?: mean)?$`), confidence: 0.9, slots: ["metric"] },
  ],
  invite_member: [
    { pattern: new RegExp(String.raw`^invite (\S+@\S+\.\S+)(?: as (?:an? )?(${ROLES}))?$`), confidence: 0.95, slots: ["email", "role"] },
    { pattern: /^invite (?:a |an )?(?:new )?(?:member|teammate|colleague|user|someone)$/, confidence: 0.8, slots: [] },
  ],
};

/** Example commands offered for unresolved input. Phrases, not intents. */
export const SUGGESTIONS: readonly string[] = [
  "show tasks",
  "compare acme with globex",
  "run deep scan on acme",
  "create a project called acme",
  "explain visibility score",
  "invite jo@example.com as viewer",
];

/**
 * Lower-cases, trims, collapses whitespace and drops trailing sentence
 * punctuation. The result is what the grammar matches AND what the cache key
 * hashes, so two spellings of one request share one cache entry.
 */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s?!.,;:]+|[\s?!.,;:]+$/g, "");
}

/** The slots that are the user's own words (a task title, a project name): stored and prefilled as typed, never lower-cased. */
const FREE_TEXT_SLOTS: ReadonlySet<string> = new Set(["title", "name"]);

/**
 * The free-text slots of `intent` as the user TYPED them. The grammar matches the lower-cased text (and the cache keys on it), so the cased words
 * are recovered per caller from the original query: the same rules, case-insensitively, over the same whitespace and edge-punctuation clean-up.
 * Only `title` and `name` are returned; every other slot stays normalised.
 */
export function freeTextSlots(intent: CommandIntent, query: string): Record<string, string> {
  const typed = query.replace(/\s+/g, " ").replace(/^[\s?!.,;:]+|[\s?!.,;:]+$/g, "");
  const out: Record<string, string> = {};
  for (const rule of RULES[intent]) {
    const found = new RegExp(rule.pattern.source, "i").exec(typed);
    if (found === null) continue;
    const slots = bind(rule, found.slice(1));
    for (const [name, value] of Object.entries(slots)) if (FREE_TEXT_SLOTS.has(name)) out[name] = value;
    if (Object.keys(out).length > 0) break;
  }
  return out;
}

function bind(rule: Rule, groups: readonly (string | undefined)[]): Record<string, string> {
  const slots: Record<string, string> = {};
  rule.slots.forEach((name, index) => {
    const value = groups[index]?.trim();
    if (value !== undefined && value.length > 0) slots[name] = value;
  });
  return slots;
}

/**
 * Every intent the input matches, best rule per intent, highest confidence
 * first. Zero entries is unresolved; one is a resolution; two or more at the
 * top confidence is ambiguity (the caller decides, the server does not guess).
 */
export function matchGrammar(normalized: string): Match[] {
  const matches: Match[] = [];
  for (const intent of COMMAND_INTENTS) {
    let best: Match | null = null;
    for (const rule of RULES[intent]) {
      const found = rule.pattern.exec(normalized);
      if (found === null) continue;
      if (best === null || rule.confidence > best.confidence) {
        best = { intent, confidence: rule.confidence, slots: bind(rule, found.slice(1)) };
      }
    }
    if (best !== null) matches.push(best);
  }
  return matches.sort((a, b) => b.confidence - a.confidence);
}

export type ActionHandling = z.infer<typeof commandActionHandlingSchema>;

export interface ActionSpec {
  readonly label: string;
  readonly isMutating: boolean;
  readonly requiredPermission: string | null;
  /**
   * STORY-085 (decision 78c): `execute` is the two actions the server runs from the bar; `open_screen` is what
   * the client finishes on its own screen (the server writes and spends nothing); `client` is answered or
   * navigated in the browser, and execute refuses it.
   */
  readonly handling: ActionHandling;
  /** `open_screen` only: the screen, and which slot fills which prefill key. */
  readonly screen?: CommandScreen;
  readonly prefill?: Readonly<Record<string, string>>;
}

/**
 * What each intent would do, for `actions[]`. `requires_confirmation` is
 * derived from `isMutating` in the service: every mutating action is confirmed
 * until the price estimator (execute's slice) can say which are free.
 */
export const ACTIONS: Readonly<Record<CommandIntent, ActionSpec>> = {
  filter_find: { label: "Filter and find", isMutating: false, requiredPermission: "project:read", handling: "client" },
  compare: { label: "Compare", isMutating: false, requiredPermission: "project:read", handling: "client" },
  navigate: { label: "Go to", isMutating: false, requiredPermission: null, handling: "client" },
  run_visibility_scan: { label: "Run a visibility scan", isMutating: true, requiredPermission: "tracking:trigger", handling: "open_screen", screen: "tools.visibility_scan", prefill: { project: "project_name" } },
  run_prompt_research: { label: "Run prompt research", isMutating: true, requiredPermission: "prompt:write", handling: "open_screen", screen: "tools.prompt_research", prefill: { project: "project_name" } },
  run_competitor_finder: { label: "Run the competitor finder", isMutating: true, requiredPermission: "project:update", handling: "open_screen", screen: "tools.competitor_finder", prefill: { project: "project_name" } },
  run_aux_audit: { label: "Run an AUX audit", isMutating: true, requiredPermission: "aux:trigger", handling: "open_screen", screen: "tools.aux_audit", prefill: { project: "project_name" } },
  run_deep_scan: { label: "Run a deep scan", isMutating: true, requiredPermission: "tracking:trigger", handling: "execute" },
  create_project: { label: "Create a project", isMutating: true, requiredPermission: "project:create", handling: "open_screen", screen: "projects.new", prefill: { name: "name" } },
  create_task: { label: "Create a task", isMutating: true, requiredPermission: "task:create", handling: "execute" },
  show_tasks: { label: "Show tasks", isMutating: false, requiredPermission: "task:read", handling: "client" },
  build_report: { label: "Build a report", isMutating: true, requiredPermission: "export:data", handling: "open_screen", screen: "reports.new", prefill: { project: "project_name" } },
  explain_metric: { label: "Explain a metric", isMutating: false, requiredPermission: null, handling: "client" },
  invite_member: { label: "Invite a member", isMutating: true, requiredPermission: "member:invite", handling: "open_screen", screen: "members.invite", prefill: { email: "email", role: "role" } },
};
