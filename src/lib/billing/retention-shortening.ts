import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import type { EmailMessage } from "../../modules/identity/ports/email-sender.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { recordDowngradeNotices, type RecordedNotice } from "./downgrade-notice-outbox.js";
import { downgradeNoticeContact } from "./downgrade-pause-notice.js";

// STORY-077 slice B · EC-41 · data-model.md §7 "Plan downgrade shortening retention": a 14-day notice names exactly what will be
// purged and when, offers a full export, and DEFERS THE FIRST PURGE TO DAY 15.
//
// Run by EVERY plan writer, inside its own tenant-context transaction, right after the plan is adopted (the Stripe webhook's
// adoption and the operator CLI `plan:set`, beside the downgrade pause of slice A):
//   1. work out whether the new plan's retention window is SHORTER than the old plan's (raw captures and/or rollups);
//   2. read the exact purge list as of the first purge date: per project, how many raw captures (and rollup days) are older
//      than the new window by then, with their oldest and newest dates. Counts and dates only: no capture text, no ids;
//   3. record the email in `downgrade_notices` (kind `retention_shortened`), the outbox the downgrade pause already uses:
//      the caller enqueues the signed tenant job `billing.downgrade_notice` AFTER its commit, which sends with no transaction
//      open and retries, so there is exactly one send path;
//   4. set `workspaces.retention_purge_not_before` = now + 15 days, which the nightly sweep honours.
// The deferral is set EVEN WHEN NOBODY CAN BE EMAILED (no billing contact): the data is protected whether or not the notice
// is deliverable. A redelivered request (the outbox row already exists) neither re-sends nor pushes the date out again.
//
// "Day 15": the notice goes out on day 0 and promises 14 days of notice. The first purge is `RETENTION_FIRST_PURGE_DAYS` = 15
// days after the plan change, so the notice period is at least 14 full days and the day of the purge is day 15. A builder
// reading of the reference's "defers the first purge to day 15"; the longer reading can only keep data longer.

export const RETENTION_NOTICE_DAYS = 14;
export const RETENTION_FIRST_PURGE_DAYS = 15;
export const RETENTION_NOTICE_KIND = "retention_shortened" as const;
/** The most projects named per list in one email; the totals are always exact. */
const MAX_NAMED_PROJECTS = 50;
const DAY_MS = 86_400_000;

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("billing.retention_notice");

/** A retention window as the plans seed encodes it: a day count; `null` and "unlimited" both mean never purged. */
export type RetentionWindow = number | "unlimited" | null;

/**
 * True when `to` purges data that `from` would still have kept: a finite `to` shorter than `from`, or `from` "unlimited".
 *
 * A `null` `from` is the matrix's "—" (not applicable at that tier: the free tier's rollups) and is NOT a promise to keep
 * anything, so a move off it is never a shortening. (The sweep itself treats null as "never purge", so a free workspace's
 * rollups older than the new plan's window go at the first sweep after an upgrade; reported to the owner, not decided here.)
 */
export function windowShortened(from: RetentionWindow, to: RetentionWindow): boolean {
  if (typeof to !== "number" || from === null) return false;
  return typeof from !== "number" || to < from;
}

export interface PurgeProjectLine {
  readonly name: string;
  readonly count: number;
  readonly oldest: Date;
  readonly newest: Date;
}

export interface PurgeListSection {
  readonly from: RetentionWindow;
  readonly to: RetentionWindow;
  /** Anything older than this goes at the first purge. */
  readonly cutoff: Date;
  readonly projects: readonly PurgeProjectLine[];
}

export interface RetentionShorteningNotice {
  readonly fromPlanName: string;
  readonly toPlanName: string;
  readonly purgeNotBefore: Date;
  readonly raw: PurgeListSection | null;
  readonly rollups: PurgeListSection | null;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);
const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
const windowText = (w: RetentionWindow): string => (typeof w === "number" ? `${String(w)} days` : "no limit");

function sectionLines(title: string, noun: [string, string], emptyText: string, section: PurgeListSection): string[] {
  const lines = [`${title} (${windowText(section.from)} before, ${windowText(section.to)} now). Anything older than ${day(section.cutoff)} is removed:`];
  if (section.projects.length === 0) {
    lines.push(`  ${emptyText} ${day(section.cutoff)}, so nothing is affected yet.`);
    return lines;
  }
  for (const p of section.projects.slice(0, MAX_NAMED_PROJECTS)) {
    lines.push(`  - ${p.name}: ${plural(p.count, noun[0], noun[1])}, ${day(p.oldest)} to ${day(p.newest)}`);
  }
  if (section.projects.length > MAX_NAMED_PROJECTS) lines.push(`  - and ${String(section.projects.length - MAX_NAMED_PROJECTS)} more`);
  const total = section.projects.reduce((sum, p) => sum + p.count, 0);
  lines.push(`  Total: ${plural(total, noun[0], noun[1])}`);
  return lines;
}

/** The notice's email: what goes, per project, and when; that nothing goes sooner; how to export; what survives. */
export function retentionShorteningEmail(to: string, notice: RetentionShorteningNotice): EmailMessage {
  const date = day(notice.purgeNotBefore);
  const lines: string[] = [
    `Your workspace moved from the ${notice.fromPlanName} plan to the ${notice.toPlanName} plan, which keeps data for a shorter time.`,
    "",
    `Nothing is deleted before ${date}. That is ${String(RETENTION_NOTICE_DAYS)} days of notice, and the first purge is on day ${String(RETENTION_FIRST_PURGE_DAYS)}. ` +
      `From ${date} the nightly retention job removes what is listed below.`,
    "",
  ];
  if (notice.raw !== null) {
    lines.push(...sectionLines("Raw answer text", ["capture", "captures"], "No existing raw answer text is older than", notice.raw), "");
  }
  if (notice.rollups !== null) {
    lines.push(...sectionLines("Daily rollups behind your charts", ["day", "days"], "No existing rollup is older than", notice.rollups), "");
  }
  lines.push(
    "What stays: your charts are built from rollups, which are kept longer than the raw answer text at every plan, so a chart survives even when the answer text behind it is gone. " +
      "Milestones you recorded are never purged by retention.",
    "",
    `To keep a copy, export your data before ${date} with the report export in Nominara (CSV or PDF). ` +
      `If you move to a plan with a longer window before then, the longer window applies again.`,
  );
  return { to, subject: "Your plan change shortens how long Nominara keeps your data", textBody: lines.join("\n") };
}

interface PlanRetention {
  readonly name: string;
  readonly raw: RetentionWindow;
  readonly rollups: RetentionWindow;
}

async function planRetention(tx: ClientBase, planKey: string): Promise<PlanRetention | null> {
  const r = await tx.query<{ display_name: string; raw: unknown; rollups: unknown }>(
    `SELECT display_name,
            entitlements->'retention.raw_captures_days'->'value' AS raw,
            entitlements->'retention.rollups_days'->'value'      AS rollups
       FROM plans WHERE key = $1`,
    [planKey],
  );
  const row = r.rows[0];
  return row === undefined ? null : { name: row.display_name, raw: row.raw as RetentionWindow, rollups: row.rollups as RetentionWindow };
}

/** Per project: raw captures that the purge would expire (the sweep's own predicate) older than `cutoff`. */
async function rawPurgeList(tx: ClientBase, workspaceId: string, cutoff: Date): Promise<PurgeProjectLine[]> {
  const r = await tx.query<{ name: string; count: string; oldest: Date; newest: Date }>(
    `SELECT p.name, count(*) AS count, min(c.captured_at) AS oldest, max(c.captured_at) AS newest
       FROM answer_captures c JOIN projects p ON p.id = c.project_id
      WHERE c.workspace_id = $1 AND c.captured_at < $2 AND c.raw_object_key IS NOT NULL
      GROUP BY p.id, p.name ORDER BY p.name, p.id`,
    [workspaceId, cutoff.toISOString()],
  );
  return r.rows.map((row) => ({ name: row.name, count: Number(row.count), oldest: row.oldest, newest: row.newest }));
}

/** Per project: rollup DAYS (not rows: a day has a row per engine and entity) older than `cutoff`. */
async function rollupPurgeList(tx: ClientBase, workspaceId: string, cutoff: Date): Promise<PurgeProjectLine[]> {
  const r = await tx.query<{ name: string; count: string; oldest: string; newest: string }>(
    `SELECT p.name, count(DISTINCT m.metric_date) AS count, min(m.metric_date)::text AS oldest, max(m.metric_date)::text AS newest
       FROM metric_daily m JOIN projects p ON p.id = m.project_id
      WHERE m.workspace_id = $1 AND m.metric_date < $2::date
      GROUP BY p.id, p.name ORDER BY p.name, p.id`,
    [workspaceId, day(cutoff)],
  );
  return r.rows.map((row) => ({ name: row.name, count: Number(row.count), oldest: new Date(`${row.oldest}T00:00:00.000Z`), newest: new Date(`${row.newest}T00:00:00.000Z`) }));
}

export interface RetentionShorteningInput {
  readonly fromPlanKey: string;
  readonly toPlanKey: string;
  /** The provider's event id or the plan writer's change key: the notice's idempotency key. */
  readonly requestId: string;
  /** Injectable for tests; the plan change's own instant otherwise. */
  readonly now?: Date;
}

/**
 * Inside the CALLER's tenant transaction. Returns the notices THIS call recorded, for the caller to enqueue after its commit;
 * `[]` when retention was not shortened, when the request was already recorded, or when nobody could be emailed.
 */
export async function recordRetentionShortening(tx: ClientBase, workspaceId: string, input: RetentionShorteningInput): Promise<RecordedNotice[]> {
  return await tracer.startActiveSpan("billing.retention_notice.record", async (span) => {
    try {
      const [from, to] = [await planRetention(tx, input.fromPlanKey), await planRetention(tx, input.toPlanKey)];
      if (from === null || to === null) return [];
      const rawShortened = windowShortened(from.raw, to.raw);
      const rollupsShortened = windowShortened(from.rollups, to.rollups);
      span.setAttributes({ "nominara.retention_notice.raw_shortened": rawShortened, "nominara.retention_notice.rollups_shortened": rollupsShortened });
      if (!rawShortened && !rollupsShortened) return [];

      const now = input.now ?? new Date();
      const purgeNotBefore = new Date(now.getTime() + RETENTION_FIRST_PURGE_DAYS * DAY_MS);
      const cutoffFor = (window: RetentionWindow): Date => new Date(purgeNotBefore.getTime() - (window as number) * DAY_MS);

      const raw: PurgeListSection | null = rawShortened ? { from: from.raw, to: to.raw, cutoff: cutoffFor(to.raw), projects: await rawPurgeList(tx, workspaceId, cutoffFor(to.raw)) } : null;
      const rollups: PurgeListSection | null = rollupsShortened ? { from: from.rollups, to: to.rollups, cutoff: cutoffFor(to.rollups), projects: await rollupPurgeList(tx, workspaceId, cutoffFor(to.rollups)) } : null;
      const sum = (s: PurgeListSection | null): number => (s === null ? 0 : s.projects.reduce((n, p) => n + p.count, 0));
      span.setAttributes({ "nominara.retention_notice.raw_captures": sum(raw), "nominara.retention_notice.rollup_days": sum(rollups) });

      const defer = async (): Promise<void> => {
        await tx.query(
          "UPDATE workspaces SET retention_purge_not_before = GREATEST(COALESCE(retention_purge_not_before, $2), $2) WHERE id = $1",
          [workspaceId, purgeNotBefore.toISOString()],
        );
      };

      const contact = await downgradeNoticeContact(tx, workspaceId);
      if (contact === null) {
        await defer();
        incrementCounter("nominara_retention_notice_total", { outcome: "no_billing_contact" });
        logger.error({ message: "retention shortened and the first purge deferred, but nobody could be emailed: no billing contact", workspace_id: workspaceId });
        return [];
      }

      const email = retentionShorteningEmail(contact, { fromPlanName: from.name, toPlanName: to.name, purgeNotBefore, raw, rollups });
      const recorded = await recordDowngradeNotices(tx, workspaceId, input.requestId, [{ kind: RETENTION_NOTICE_KIND, message: email }]);
      if (recorded.length === 0) {
        // A redelivery: its notice exists, and the deferral it set must not move.
        incrementCounter("nominara_retention_notice_total", { outcome: "already_recorded" });
        return [];
      }
      await defer();
      await new AuditChainService().append(tx, {
        workspaceId,
        actorType: "system",
        actorId: SYSTEM_ACTOR_ID,
        actorIp: null,
        actorUa: "operator:retention-notice",
        action: "billing.retention.shortened",
        resourceType: "workspace",
        resourceId: workspaceId,
        beforeState: null,
        afterState: { raw_captures: sum(raw), rollup_days: sum(rollups), purge_not_before: purgeNotBefore.toISOString() },
        requestId: input.requestId,
        supportGrantId: null,
        severity: "notice",
      });
      incrementCounter("nominara_retention_notice_total", { outcome: "recorded" });
      logger.log({ message: "retention shortened: notice recorded, first purge deferred", workspace_id: workspaceId, raw_captures: sum(raw), rollup_days: sum(rollups), purge_not_before: purgeNotBefore.toISOString() });
      return recorded;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
