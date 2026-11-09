import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { PreconditionUnmetError, PriceChangedError } from "../../api/errors/domain-errors.js";
import type { EnqueueAutoTopup } from "../credits/auto-topup-request.js";
import { requireConfirmedCredits } from "../credits/confirmed-credits.js";
import { debitInTransaction, idempotencyKeyFor, includedGrantOf } from "../credits/debit.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-046 AC3 - the prompt activation charge.
//
// THE RULE (owner decision 2026-10-14; plans-and-entitlements.md section 4:
// "Prompt generation beyond the free 10 - 1 per prompt activated. A rejected
// prompt is not charged. Typing a prompt manually is 0"):
//
//   * a GENERATED prompt is charged ONCE, at its first activation - the first
//     time it leaves `archived` - and never again. Pausing, resuming,
//     archiving and activating it again are free, and so is replaying the call.
//   * the first `prompts.free_at_creation` (10) generated prompts a PROJECT
//     ever activates are free. The allowance is per project, not per workspace,
//     and it is spent by distinct prompts, not by activation events.
//   * every one after that costs `prompts.credits_per_generated` (1).
//   * a rejected candidate is never charged: it is never activated.
//   * a manually typed prompt is never charged and does not spend the allowance.
//
// This reading resolves section 4 against `FR-CRD-06` ("unactivated candidates
// ... activate later at 0 credits"): FR-CRD-06's later activation is free only
// in the sense that nothing is charged for GENERATING them. Reading it as
// "activation is free" would reward activating one now and the other fourteen
// later, which is the perverse incentive the story names.
//
// THE FACT IS DURABLE, on the row: `first_activated_at` (when it first left
// `archived`) and `activation_credits` (what that cost). The count of used free
// slots is read from the same column, so it survives pause, archive and a
// restart, and a soft-deleted prompt still counts - deleting must not hand a
// free slot back.
//
// THE QUOTE (owner decision 2026-10-15, option C). The price is variable - it depends on which of the named prompts
// are new to the project and how much of the free allowance is left - so `CreditGuard`'s flat quote cannot carry it.
// `quoteActivation` computes it, by the SAME code `chargeForActivation` charges by, and the server serves it on a
// read-only preview route. When the charge is above 0 the request must echo that figure in
// `X-Nominara-Confirmed-Credits`; it is compared with the figure recomputed UNDER THE PROJECT LOCK, and a difference
// is `409 price_changed` naming both. A fully free activation debits nothing and needs no header.
//
// CALLER CONTRACT. The caller holds the PROJECT row lock (`SELECT ... FOR
// UPDATE`) before reading the prompts it passes in. Everything here - which
// prompts are new, how much of the allowance is left - is decided from rows
// that lock protects; without it two concurrent activations both read "10 free
// slots left" and both take them.

const logger = new Logger("prompts.activation-charge");
const tracer = trace.getTracer("nominara-api");

export const PROMPT_FREE_ALLOWANCE_KEY = "prompts.free_at_creation";
export const PROMPT_PRICE_KEY = "prompts.credits_per_generated";

export interface ActivationCandidate {
  readonly id: string;
  readonly generationSource: string;
  readonly firstActivatedAt: Date | null;
}

export interface ActivationChargePlan {
  /** First activation, inside the allowance: recorded at 0. */
  readonly free: readonly string[];
  /** First activation, beyond the allowance: recorded at the price. */
  readonly charged: readonly string[];
}

/**
 * Which of `candidates` are first activations, and which of those are free.
 *
 * Pure, and in the order given: the caller's order decides which prompts take
 * the last free slots, so the same request always prices the same way.
 */
export function planActivationCharge(candidates: readonly ActivationCandidate[], freeRemaining: number): ActivationChargePlan {
  const free: string[] = [];
  const charged: string[] = [];
  // A negative remainder (the allowance was lowered below what a project already used) falls through to `charged`.
  let remaining = freeRemaining;
  for (const candidate of candidates) {
    if (candidate.generationSource !== "generated") continue;
    if (candidate.firstActivatedAt !== null) continue;
    if (remaining > 0) {
      free.push(candidate.id);
      remaining -= 1;
    } else {
      charged.push(candidate.id);
    }
  }
  return { free, charged };
}

type Entitlements = Readonly<Record<string, { readonly value: unknown } | undefined>>;

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * `prompts.credits_per_generated`: what ONE generated prompt costs beyond the free allowance. The single reading of the price - the in-project activation charge
 * and Prompt Research's per-prompt keep (STORY-080) both go through it, which is what makes "the tool cannot undercut in-project generation" true by construction.
 */
export function generatedPromptPrice(entitlements: Entitlements): number {
  const resolved = wholeNumber(entitlements[PROMPT_PRICE_KEY]?.value);
  if (resolved === null) {
    // A plan that holds prompts but publishes no price is an unfinished
    // setup, not a free tier. Charging a default would bill against a
    // schedule nobody agreed; waving it through would give prompts away.
    throw new PreconditionUnmetError({
      message: `this workspace's prompt activation price resolves to "${String(entitlements[PROMPT_PRICE_KEY]?.value)}", which is not a credit figure`,
      details: { reason: "price_not_agreed" },
    });
  }
  return resolved;
}

export interface QuoteActivationInput {
  readonly projectId: string;
  /** Exactly the prompts that are leaving `archived` in this call, in request order. */
  readonly candidates: readonly ActivationCandidate[];
  readonly entitlements: Entitlements;
}

export interface ActivationQuote extends ActivationChargePlan {
  /** Credits per charged prompt: 0 when nothing is charged (the plan may then publish no price). */
  readonly price: number;
  /** What activating these candidates debits now: `price` x `charged.length`. */
  readonly total: number;
}

/** True when at least one candidate is a generated prompt that has never been activated. */
function hasFirstActivation(candidates: readonly ActivationCandidate[]): boolean {
  return candidates.some((c) => c.generationSource === "generated" && c.firstActivatedAt === null);
}

/**
 * What activating `candidates` costs, by the rule `chargeForActivation` charges by. Reads, writes nothing.
 *
 * The caller decides whether the read is under the project lock: the activation holds it, the preview does not (a
 * preview that locked the project would let any reader stall every writer, and it is advisory by construction -
 * the activation recomputes and compares).
 */
export async function quoteActivation(tx: ClientBase, input: QuoteActivationInput): Promise<ActivationQuote> {
  if (!hasFirstActivation(input.candidates)) return { free: [], charged: [], price: 0, total: 0 };

  const allowance = wholeNumber(input.entitlements[PROMPT_FREE_ALLOWANCE_KEY]?.value) ?? 0;
  const used = await countFreeAllowanceUsed(tx, input.projectId);
  const plan = planActivationCharge(input.candidates, allowance - used);

  const price = plan.charged.length > 0 ? generatedPromptPrice(input.entitlements) : 0;
  return { ...plan, price, total: price * plan.charged.length };
}

export interface ChargeActivationInput {
  readonly workspaceId: string;
  readonly actorId: string;
  readonly projectId: string;
  /** Exactly the prompts that are leaving `archived` in this call, in request order. */
  readonly candidates: readonly ActivationCandidate[];
  readonly entitlements: Entitlements;
  /**
   * The parsed `X-Nominara-Confirmed-Credits`, or null/absent when the request carried none. Required (and compared)
   * only when the charge is above 0.
   */
  readonly confirmedCredits?: number | null;
  /** Asks for an auto top-up after the debit commits. Absent when the process has no queue producer. */
  readonly autoTopup?: EnqueueAutoTopup;
}

/**
 * Charge for, and record, the first activation of `candidates`. Returns the
 * credits charged (0 when everything was free, already activated, or manual).
 *
 * Throws, and writes nothing (the caller's transaction rolls back with it):
 *   - 400 `validation_failed` when the charge is above 0 and no confirmed figure came with the request;
 *   - 409 `price_changed` when the confirmed figure is not the figure recomputed here;
 *   - 402 `insufficient_credits` when the wallet cannot cover it.
 */
export async function chargeForActivation(tx: ClientBase, input: ChargeActivationInput): Promise<number> {
  if (!hasFirstActivation(input.candidates)) return 0;

  return tracer.startActiveSpan("prompts.activation.charge", async (span) => {
    try {
      const quote = await quoteActivation(tx, input);
      const { price, total } = quote;
      span.setAttributes({
        "nominara.prompts.activated_free": quote.free.length,
        "nominara.prompts.activated_charged": quote.charged.length,
        "nominara.credits.charged": total,
      });

      if (total > 0) {
        const confirmed = requireConfirmedCredits(input.confirmedCredits ?? null);
        if (confirmed !== total) {
          throw new PriceChangedError({
            message: "the confirmed price does not match this activation's current price",
            // BOTH FIGURES: a client told only "it changed" cannot tell whether to re-quote or give up.
            details: {
              shown: confirmed,
              recomputed: total,
              reason: `${PROMPT_PRICE_KEY} resolved to ${String(price)} for ${String(quote.charged.length)} prompt(s) beyond the free allowance`,
            },
          });
        }
        await debitInTransaction(tx, {
          workspaceId: input.workspaceId,
          actorId: input.actorId,
          actorType: "user",
          actionCode: "prompt_activate",
          credits: total,
          idempotencyKey: idempotencyKeyFor("prompt_activate", input.projectId, quote.charged),
          projectId: input.projectId,
          unitDetail: { prompts: quote.charged.length, engines: 0, cells_charged: 0, cells_cached: 0 },
          includedGrant: includedGrantOf(input.entitlements),
          ...(input.autoTopup === undefined ? {} : { autoTopup: input.autoTopup }),
        });
      }

      await recordFirstActivation(tx, quote.free, 0);
      await recordFirstActivation(tx, quote.charged, price);

      incrementCounter("nominara_prompts_activation_charges_total", { outcome: total > 0 ? "charged" : "free" });
      logger.log({
        event: "prompts.activation.charged",
        workspace_id: input.workspaceId,
        project_id: input.projectId,
        prompts_free: quote.free.length,
        prompts_charged: quote.charged.length,
        credits: total,
      });
      return total;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      incrementCounter("nominara_prompts_activation_charges_total", { outcome: refusalOutcome((error as { code?: string }).code) });
      throw error;
    } finally {
      span.end();
    }
  });
}

function refusalOutcome(code: string | undefined): string {
  switch (code) {
    case "insufficient_credits":
      return "refused_insufficient_credits";
    case "price_changed":
      return "refused_price_changed";
    case "validation_failed":
      return "refused_price_unconfirmed";
    default:
      return "error";
  }
}

/**
 * How many of the project's free slots are spent.
 *
 * One per question: a reworded prompt is a new row that INHERITS its
 * predecessor's fact, so only the head of each chain (`superseded_by IS NULL`)
 * is counted. No `deleted_at` filter, on purpose.
 */
async function countFreeAllowanceUsed(tx: ClientBase, projectId: string): Promise<number> {
  const result = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM tracked_prompts
      WHERE project_id = $1 AND generation_source = 'generated'
        AND first_activated_at IS NOT NULL AND superseded_by IS NULL`,
    [projectId],
  );
  return result.rows[0]?.n ?? 0;
}

async function recordFirstActivation(tx: ClientBase, ids: readonly string[], credits: number): Promise<void> {
  if (ids.length === 0) return;
  await tx.query(
    `UPDATE tracked_prompts SET first_activated_at = now(), activation_credits = $2 WHERE id = ANY($1::uuid[])`,
    [[...ids], credits],
  );
}

/** An edit starts a new row for the same question; it inherits whether, and at what price, the question was activated. */
export async function inheritFirstActivation(
  tx: ClientBase,
  newPromptId: string,
  from: { readonly firstActivatedAt: Date | null; readonly activationCredits: number },
): Promise<void> {
  if (from.firstActivatedAt === null) return;
  await tx.query(`UPDATE tracked_prompts SET first_activated_at = $2, activation_credits = $3 WHERE id = $1`, [
    newPromptId,
    from.firstActivatedAt,
    from.activationCredits,
  ]);
}
