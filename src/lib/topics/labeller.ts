import { AUTO_LABEL_MAX } from "./constants.js";

// STORY-047 AC2 - a cluster's label is a phrase a customer would recognise, never a token list or an identifier.
//
// The model that names clusters sits behind this port. NO MODEL IS BOUND HERE: the Flash-class client STORY-045 binds for the
// naturaliser is on a sibling branch, so the handler's default is the deterministic template below. Binding Gemini is a one-line
// change in `createTopicClusterHandler` once STORY-045 is merged and its client can be shared.
//
// A label a model returns is checked (`isReadableLabel`) and replaced by the template when it fails, so a bad model response is a
// worse label, never a bad row. A model that throws or hangs the job is not allowed either: any error falls back.

export const TOPIC_LABELLER = Symbol("TOPIC_LABELLER");

export interface TopicLabelRequest {
  /** Member prompt texts, most representative (nearest the group's centre) first. Customer text: never logged. */
  readonly prompts: readonly string[];
}

export interface TopicLabeller {
  label(request: TopicLabelRequest): Promise<string>;
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A readable label: one line, 1-80 characters, with a letter in it, not an identifier, and not a comma-separated list of tokens. */
export function isReadableLabel(label: string): boolean {
  const text = label.trim();
  if (text.length === 0 || text.length > AUTO_LABEL_MAX) return false;
  if (/[\r\n\t]/u.test(label)) return false;
  if (!/\p{L}/u.test(text)) return false;
  if (UUID_LIKE.test(text)) return false;
  // `cluster_17`, `topic-3`, `snake_case_ids`: a single word with an underscore or a trailing number is an identifier, not a phrase.
  if (/^[\p{L}]+[_-]?\d+$/u.test(text) || /^\w+_\w+$/u.test(text)) return false;
  // Three or more comma-separated fragments with no spaces inside most of them: a token list.
  const fragments = text.split(",").map((part) => part.trim());
  if (fragments.length >= 3 && fragments.filter((part) => !part.includes(" ")).length >= 2) return false;
  return true;
}

const LEADING_QUESTION = /^(what(?:'s| is| are)(?: the| a)?|which(?: is| are)(?: the| a)?|how do i|how can i|how should i|should i|can you recommend|i need|tell me(?: about)?)\s+/iu;

/** Deterministic: the most representative prompt, cleaned into a short noun phrase. The documented fallback (FR-FAN-01d's determinism). */
export class TemplateTopicLabeller implements TopicLabeller {
  label(request: TopicLabelRequest): Promise<string> {
    return Promise.resolve(templateLabel(request.prompts[0] ?? ""));
  }
}

export function templateLabel(prompt: string): string {
  let text = prompt.replace(/\s+/gu, " ").replace(/[?!]+/gu, "").trim().replace(LEADING_QUESTION, "").replace(/[.:;,\s]+$/u, "");
  if (text.length > AUTO_LABEL_MAX) {
    const cut = text.slice(0, AUTO_LABEL_MAX + 1);
    const at = cut.lastIndexOf(" ");
    text = (at > 0 ? cut.slice(0, at) : text.slice(0, AUTO_LABEL_MAX)).replace(/[.:;,\s]+$/u, "");
  }
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

export async function labelOrFallback(
  labeller: TopicLabeller,
  request: TopicLabelRequest,
): Promise<{ readonly label: string; readonly source: "model" | "template" }> {
  try {
    const label = (await labeller.label(request)).trim();
    if (isReadableLabel(label)) return { label, source: "model" };
  } catch {
    // Fall through: a model failure is a template label, not a failed job.
  }
  const fallback = templateLabel(request.prompts[0] ?? "");
  // A prompt that reduces to nothing readable still gets a stable, human label rather than a blank.
  return { label: isReadableLabel(fallback) ? fallback : "General questions", source: "template" };
}

/** Makes `label` distinct from everything in `taken` (lower-cased, mirroring `ux_topic_clusters`), records it, and returns it. */
export function uniqueLabel(label: string, taken: Set<string>): string {
  let candidate = label;
  let n = 1;
  while (taken.has(candidate.toLowerCase())) {
    n += 1;
    candidate = `${label} (${String(n)})`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}
