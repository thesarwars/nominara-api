import { createHash } from "node:crypto";
import type { ClientBase } from "pg";
import { entitlementGranted } from "../entitlements/granted.js";

// OWNER DECISION 34 (plans-7day/decisions-2026-10-28.md), item 1 - the free onboarding audit.
//
// Nothing produced a `crawl.audit` job, so the AUX screen of a real project stayed empty. The project's FIRST SCAN is the moment the
// product starts looking at it (STORY-070: `capture.plan` plans the first scheduled run), so that is where the audit is requested.
// It is FREE: an onboarding audit is inside the subscription envelope (plans-and-entitlements.md "Project actions"), so nothing here
// touches the credit ledger.
//
// ONCE PER PROJECT, three independent ways, so a redelivery, a replan or a race cannot make a second one:
//   1. the audit id is DERIVED from the project (below), so a second job addresses the same `aux_audits` row, and `crawl.audit`
//      skips an audit that already finished and claims the row with `INSERT ... ON CONFLICT (id) DO NOTHING`;
//   2. the queue key is `aux:{project}:{audit}` (system-architecture.md section 4), so a job still queued is not added twice;
//   3. `onboardingAuditWanted` asks for nothing once the project has ANY audit, including a manual one a customer ran first.
//
// Scope is NOT chosen here. `crawl.audit` decides it from the verification state (STORY-048): an unverified domain gets the supplied
// URL and the site files at public-surface scope, whatever a producer says, and names the rules that could not run.

/**
 * The entitlement that says whether a plan has the PAGE audit at all (plans-and-entitlements.md: Free is off; the paid tiers are a quota or `configurable`). It does
 * not gate the free site-files check (owner decision 47): a plan without it gets the onboarding audit as `siteFilesOnly`.
 */
export const AUX_AUDITS_ENTITLEMENT = "aux.scheduled_audits";

/**
 * Whether a plan includes AUX audits. `false`, `null` and an absent entry all mean no: fail closed. The one reading, shared by the manual route (403
 * `feature_not_in_plan`) and the onboarding producer (no audit), so the two can never disagree about who has the feature. A Free workspace's first scan runs the
 * site-files-only check (owner decision 47), never the page audit.
 */
export function auxAuditsIncluded(entitlements: Readonly<Record<string, { readonly value: unknown } | undefined>>): boolean {
  return entitlementGranted(entitlements[AUX_AUDITS_ENTITLEMENT]?.value);
}

/** Namespace for the derived id: changing it changes every project's onboarding audit id. */
const ONBOARDING_AUDIT_NAMESPACE = "nominara.aux.onboarding-audit.v1";

/**
 * A UUID derived from the project id (the version-5 shape: a hash with the version and variant bits set), so the id is stable for
 * a project and a different project never collides with it. `crawlAuditJobPayloadSchema` requires a UUID.
 */
export function onboardingAuditId(projectId: string): string {
  const bytes = createHash("sha256").update([ONBOARDING_AUDIT_NAMESPACE, projectId].join("|")).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/** The queue's idempotency key for an audit job: `aux:{project}:{audit}`. */
export function crawlAuditIdempotencyKey(projectId: string, auditId: string): string {
  return ["aux", projectId, auditId].join(":");
}

/**
 * True when the project has no audit of any kind. Runs in the caller's tenant transaction, so RLS scopes it to the workspace; the
 * project predicate is the question itself.
 */
export async function onboardingAuditWanted(tx: ClientBase, projectId: string): Promise<boolean> {
  const existing = await tx.query("SELECT 1 FROM aux_audits WHERE project_id = $1 LIMIT 1", [projectId]);
  return (existing.rowCount ?? 0) === 0;
}

/** What a producer of `crawl.audit` is: injected so a test sees the job and no queue is needed. Workspace id and signing are the producer's. */
export type EnqueueCrawlAudit = (workspaceId: string, payload: { projectId: string; auditId: string; trigger: "onboarding"; siteFilesOnly?: true }, idempotencyKey: string) => Promise<unknown>;
