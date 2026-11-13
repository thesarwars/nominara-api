import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { StripeUpstreamError, type FetchedStripeObject, type StripeGateway } from "./stripe/stripe-gateway.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-075 AC11 / owner decision 2026-10-28 section 100(e) - the nightly provider-versus-local drift check.
//
// *** IT ALERTS AND NEVER WRITES. *** Nothing here touches a subscription, an entitlement or a wallet: the webhook's fresh-fetch
// reconciliation (`subscription-state.ts`) is the only writer of provider state, and a drift is resolved by a human or by the next
// webhook, never by this job. It takes no tenant lock and is nowhere near `lifecycle.service.ts`'s lock order.
//
// The local rows are read a page at a time by the caller's `loadPage` (which releases its connection before returning), and the
// Stripe fetches happen here with no connection and no transaction held (KAD-06 / ADR-0003).

export const DRIFT_PAGE_SIZE = 100;
/** Stripe's default read limit is ~100 requests/s; five in flight is far below it, and a nightly job has no deadline. */
export const DRIFT_CONCURRENCY = 5;

export type DriftField =
  | "status"
  | "current_period_start"
  | "current_period_end"
  | "cancel_at_period_end"
  | "seats_purchased"
  | "projects_purchased"
  | "plan_key"
  | "trial_ends_at"
  | "billing_interval"
  | "remote_missing";

export interface LocalStripeSubscription {
  readonly id: string;
  readonly workspaceId: string;
  readonly stripeSubscriptionId: string;
  readonly planKey: string;
  readonly status: string;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly cancelAtPeriodEnd: boolean;
  readonly trialEndsAt: Date | null;
  readonly billingInterval: string;
  readonly seatsPurchased: number;
  readonly projectsPurchased: number;
}

export interface DriftDeps {
  /** Keyset page of local `provider = 'stripe'` subscriptions with `id > afterId`, ordered by id. */
  readonly loadPage: (afterId: string | null, limit: number) => Promise<readonly LocalStripeSubscription[]>;
  readonly gateway: Pick<StripeGateway, "fetchObject">;
}

export interface DriftResult {
  readonly checked: number;
  readonly drifted: number;
  readonly errors: number;
  readonly skipped: number;
}

const ENTITLED: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);
// Ended states are stored locally as `free` + `active` (subscription-state.ts), so that is what is compared.
const ENDED: ReadonlySet<string> = new Set(["canceled", "incomplete_expired", "unpaid", "paused"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : null;
}

function lines(raw: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  const container = raw.items;
  return isRecord(container) && Array.isArray(container.data) ? container.data.filter(isRecord) : [];
}

function kindOf(line: Record<string, unknown>): string | null {
  const price = line.price;
  if (!isRecord(price) || !isRecord(price.product) || !isRecord(price.product.metadata)) return null;
  const kind = price.product.metadata.nominara_kind;
  return typeof kind === "string" ? kind : null;
}

/** The drifted fields, or `null` when the remote subscription is not one this product reconciles (nothing to compare). */
export function driftFields(local: LocalStripeSubscription, remote: FetchedStripeObject | null): DriftField[] | null {
  if (remote === null) return ["remote_missing"];
  const raw = remote.raw;
  const status = typeof raw.status === "string" ? raw.status : "";
  const planKey = remote.metadata.plan_key;
  // The webhook ignores these too: payment not taken, or not created by this product.
  if (status === "incomplete" || planKey === undefined || planKey.length === 0) return null;

  const fields: DriftField[] = [];
  const entitled = ENTITLED.has(status);
  if (!entitled && !ENDED.has(status)) return ["status"];

  if (local.status !== (entitled ? status : "active")) fields.push("status");
  if (local.planKey !== (entitled ? planKey : "free")) fields.push("plan_key");

  const all = lines(raw);
  const planLine = all.find((line) => kindOf(line) === "plan");
  const start = seconds(raw.current_period_start) ?? seconds((planLine ?? all[0])?.current_period_start);
  const end = seconds(raw.current_period_end) ?? seconds((planLine ?? all[0])?.current_period_end);
  if (start !== null && local.currentPeriodStart.getTime() !== start) fields.push("current_period_start");
  if (end !== null && local.currentPeriodEnd.getTime() !== end) fields.push("current_period_end");
  if (local.cancelAtPeriodEnd !== (raw.cancel_at_period_end === true)) fields.push("cancel_at_period_end");

  let seats = 1;
  let projects = 0;
  for (const line of all) {
    const quantity = typeof line.quantity === "number" && line.quantity > 0 ? line.quantity : 0;
    if (kindOf(line) === "extra_seat") seats += quantity;
    if (kindOf(line) === "extra_project") projects += quantity;
  }
  // The reconciler writes both (`subscription-state.ts`): the trial end straight from `trial_end`, the interval from the plan item's price.
  if ((local.trialEndsAt?.getTime() ?? null) !== seconds(raw.trial_end)) fields.push("trial_ends_at");
  const price = planLine?.price;
  const recurring = isRecord(price) && isRecord(price.recurring) ? price.recurring.interval : undefined;
  const interval = recurring === "year" ? "annual" : recurring === "month" ? "monthly" : remote.metadata.billing_interval === "annual" ? "annual" : "monthly";
  if (local.billingInterval !== interval) fields.push("billing_interval");
  if (local.seatsPurchased !== seats) fields.push("seats_purchased");
  if (local.projectsPurchased !== projects) fields.push("projects_purchased");
  return fields;
}

export async function runStripeDriftCheck(
  deps: DriftDeps,
  options: { readonly pageSize?: number; readonly concurrency?: number } = {},
): Promise<DriftResult> {
  const logger = new Logger("billing.stripe_drift");
  const tracer = trace.getTracer("nominara-api");
  const pageSize = options.pageSize ?? DRIFT_PAGE_SIZE;
  const concurrency = Math.max(1, options.concurrency ?? DRIFT_CONCURRENCY);
  let checked = 0;
  let drifted = 0;
  let errors = 0;
  let skipped = 0;

  const checkOne = async (row: LocalStripeSubscription): Promise<void> => {
    let fields: DriftField[] | null;
    try {
      fields = driftFields(row, await deps.gateway.fetchObject("subscription", row.stripeSubscriptionId));
    } catch (error) {
      // One failed fetch must not hide the rest of the estate; it is counted and the next night retries it. A Stripe/network failure
      // (`StripeUpstreamError`) is told apart from a CODE BUG (anything else), which is logged at error level. The error CLASS NAME only:
      // a message can carry a customer or subscription id.
      errors += 1;
      const reason = error instanceof StripeUpstreamError ? "stripe" : "internal";
      incrementCounter("nominara_billing_stripe_drift_errors_total", { reason });
      const line = { event: "stripe_drift_fetch_failed", reason, error_class: error instanceof Error ? error.constructor.name : typeof error, subscription_id: row.id, workspace_id: row.workspaceId };
      if (reason === "internal") logger.error(line);
      else logger.warn(line);
      return;
    } finally {
      checked += 1;
    }
    if (fields === null) {
      skipped += 1;
      return;
    }
    if (fields.length === 0) return;
    drifted += 1;
    for (const field of fields) incrementCounter("nominara_billing_stripe_drift_total", { field });
    // Ids and field NAMES only: never a value, an amount, an email or anything from the Stripe customer.
    logger.warn({ event: "stripe_drift_detected", subscription_id: row.id, workspace_id: row.workspaceId, fields });
  };

  await tracer.startActiveSpan("billing.stripe_drift", async (span) => {
    try {
      let afterId: string | null = null;
      for (;;) {
        const page = await deps.loadPage(afterId, pageSize);
        if (page.length === 0) break;
        let next = 0;
        const worker = async (): Promise<void> => {
          while (next < page.length) {
            const row = page[next++];
            if (row !== undefined) await checkOne(row);
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, page.length) }, worker));
        afterId = page[page.length - 1]?.id ?? null;
        if (page.length < pageSize || afterId === null) break;
      }
      span.setAttributes({ "nominara.stripe_drift.checked": checked, "nominara.stripe_drift.drifted": drifted, "nominara.stripe_drift.errors": errors, "nominara.stripe_drift.skipped": skipped });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });

  // Errors on at least half of what was checked: the run did not really observe the estate (an outage or a rate limit). Distinct outcome and an
  // error-level line for an alert to key on. The job does NOT fail: a retry would repeat the Stripe load that is probably the cause.
  const degraded = checked > 0 && errors * 2 >= checked;
  incrementCounter("nominara_billing_stripe_drift_runs_total", { outcome: degraded ? "degraded" : "ok" });
  if (degraded) logger.error({ event: "stripe_drift_degraded", checked, errors });
  logger.log({ event: "stripe_drift_run", checked, drifted, errors, skipped });
  return { checked, drifted, errors, skipped };
}
