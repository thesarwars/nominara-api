// STORY-053 — the shape every patch generator returns, before it is a row.
//
// PURE: nothing here touches a database, a clock or the network. A generator takes what the crawl already fetched and returns a
// PatchDraft, or throws PatchRejectedError when its own output fails a gate. The caller (the crawl.audit commit) writes the row.

export type PatchKind = "markdown" | "html_fragment" | "jsonld" | "robots";

export interface PatchPrecondition {
  readonly kind: "file_hash" | "page_hash" | "file_absent";
  /** `sha256:<hex>`, or null for `file_absent`. */
  readonly value: string | null;
}

export interface PatchReversal {
  readonly operation: "remove_block" | "delete_file" | "replace_file" | "remove_fragment" | "remove_jsonld" | "restore_jsonld";
  /** What to remove or put back; null when the operation needs none (delete_file). */
  readonly content: string | null;
}

export interface PatchDraft {
  readonly ruleCode: string;
  readonly kind: PatchKind;
  readonly targetUrl: string;
  /** sha256 of the file or page the patch was made from: the customer's change detector. 32 bytes. */
  readonly contentBeforeHash: Buffer;
  readonly contentAfter: string;
  /** null when no diff applies (a fragment) or the input was too large to diff. */
  readonly unifiedDiff: string | null;
  readonly jsonldBlocks: Record<string, unknown>[] | null;
  readonly reversal: PatchReversal;
  readonly preconditions: PatchPrecondition[];
  readonly explanation: string;
  /** Where every derived value came from: the page's own content, or a named Nominara template. Never empty. */
  readonly derivation: string;
  readonly requiresHumanReview: boolean;
  readonly reviewReason: string | null;
  readonly riskFlags: string[];
}

export type PatchRejectionReason =
  | "would_reduce_access"
  | "malformed_robots"
  | "ineffective"
  | "prohibited_markup"
  | "malformed_markup"
  | "invalid_jsonld"
  | "underived_value"
  | "no_change"
  | "no_heading"
  /** The generator itself crashed (not a gate rejecting its output): the finding is kept, the patch is not offered. */
  | "generator_error";

/** A generator's own output failed a gate. A hard error, never a stripped or quietly adjusted result. */
export class PatchRejectedError extends Error {
  constructor(
    readonly reason: PatchRejectionReason,
    message: string,
    readonly detail: Record<string, unknown> | undefined = undefined,
  ) {
    super(`${reason}: ${message}`);
    this.name = "PatchRejectedError";
  }
}
