import { createHash } from "node:crypto";
import type { PatchKind, PatchPrecondition } from "./types.js";

// STORY-053 AC3 — the precondition hash is the customer's change detector. In v1 nothing applies a patch automatically, so the hash
// answers one question the interface must state plainly: does the file still look the way it did when the patch was made?

export const sha256Of = (value: string | Buffer): Buffer => createHash("sha256").update(value).digest();
export const sha256Tag = (hash: Buffer): string => `sha256:${hash.toString("hex")}`;

/** What the latest audit of the project observed about the files a patch can be checked against. */
export interface LatestAuditFacts {
  /** sha256 of robots.txt as fetched; null = the audit could not read it. */
  readonly robotsHash: Buffer | null;
  /** null = the audit could not tell. */
  readonly llmsTxtPresent: boolean | null;
}

export interface PatchCheckable {
  readonly kind: PatchKind;
  readonly contentBeforeHash: Buffer;
  readonly preconditions: readonly PatchPrecondition[];
}

/**
 * true = unchanged since generation, false = changed (the patch may no longer apply cleanly), null = not re-checked.
 *
 * null is NOT false. A page-level patch has nothing to compare until page hashes are audited (STORY-051), and an audit that could not
 * read the file observed nothing; neither is evidence that the page changed, and reporting either as "changed" or "unchanged" would
 * be a guess presented as a fact.
 */
export function pageMatches(patch: PatchCheckable, audit: LatestAuditFacts | null): boolean | null {
  if (audit === null) return null;
  const precondition = patch.preconditions[0];
  if (precondition === undefined) return null;
  if (patch.kind === "robots" && precondition.kind === "file_hash") {
    return audit.robotsHash === null ? null : audit.robotsHash.equals(patch.contentBeforeHash);
  }
  if (patch.kind === "markdown" && precondition.kind === "file_absent") {
    return audit.llmsTxtPresent === null ? null : !audit.llmsTxtPresent;
  }
  return null;
}
