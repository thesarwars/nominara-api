import { createHash } from "node:crypto";
import { canonicalJson } from "../json/canonical.js";
import type { ToolKey } from "../../../contracts/tools/index.js";

// STORY-078 AC4 - `tool_runs.input_hash` = sha256(normalise(tool | inputs | engines)). The same request from two callers produces the same
// hash, so Compare Runs finds a comparable pair by `ix_tr_diff_pairs` instead of scanning the timeline.
//
// What normalising means here, and what it does not:
//   * text: Unicode NFC, whitespace collapsed, case folded. "Best   CRM" and "best crm" are the same question;
//   * a URL: scheme, host (the URL parser folds it), path and query are compared; the fragment and a trailing slash are not;
//   * a prompt set and an engine set are SETS: order and duplicates do not change the hash;
//   * an absent input and an empty one are the same (null), so a client that sends "" and one that omits the key agree;
//   * `locale` is part of the request (the same query in two locales is two different questions) and defaults to en-US, the column default;
//   * a Compare pair is ORDERED: base and compare are not interchangeable, a diff reads one against the other.
// Case folding is deliberate even for URL paths: the product compares what a person typed, and two runs that differ only by path
// case are far more likely to be one page than two. The hash is a comparability key, never an identity or a security boundary.

export interface ToolInputs {
  readonly brandName?: string | null | undefined;
  readonly brandUrl?: string | null | undefined;
  readonly targetUrl?: string | null | undefined;
  readonly queryText?: string | null | undefined;
  readonly promptTexts?: readonly string[] | null | undefined;
  readonly engineKeys?: readonly string[] | null | undefined;
  readonly locale?: string | null | undefined;
  readonly diffBaseRunId?: string | null | undefined;
  readonly diffCompareRunId?: string | null | undefined;
}

export const DEFAULT_TOOL_LOCALE = "en-US";

export function normaliseText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const folded = value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
  return folded === "" ? null : folded;
}

export function normaliseUrl(value: string | null | undefined): string | null {
  const text = normaliseText(value);
  if (text === null) return null;
  try {
    const url = new URL(text);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/u, "") : "";
    return `${url.protocol}//${url.host}${path}${url.search}`;
  } catch {
    return text;
  }
}

function normaliseSet(values: readonly string[] | null | undefined): string[] | null {
  const set = new Set<string>();
  for (const value of values ?? []) {
    const folded = normaliseText(value);
    if (folded !== null) set.add(folded);
  }
  return set.size === 0 ? null : [...set].sort();
}

export function toolInputHash(toolKey: ToolKey, inputs: ToolInputs): Buffer {
  const normalised = {
    tool: toolKey,
    brand_name: normaliseText(inputs.brandName),
    brand_url: normaliseUrl(inputs.brandUrl),
    target_url: normaliseUrl(inputs.targetUrl),
    query_text: normaliseText(inputs.queryText),
    prompt_texts: normaliseSet(inputs.promptTexts),
    engine_keys: normaliseSet(inputs.engineKeys),
    locale: normaliseText(inputs.locale) ?? normaliseText(DEFAULT_TOOL_LOCALE),
    diff_base_run_id: normaliseText(inputs.diffBaseRunId),
    diff_compare_run_id: normaliseText(inputs.diffCompareRunId),
  };
  return createHash("sha256").update(canonicalJson(normalised), "utf8").digest();
}
