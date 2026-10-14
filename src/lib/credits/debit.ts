import { createHash } from "node:crypto";
import type { ClientBase } from "pg";
import type { LedgerUnitDetail } from "../../../contracts/billing/ledger-unit-detail.schema.js";
import { InsufficientCreditsError } from "../../api/errors/domain-errors.js";
import { resolveBillingPeriod } from "../usage/billing-period.js";
import { provisionWalletWithGrant } from "./balance.js";
import { appendLedgerEntry, type LedgerActionCode } from "./ledger.js";
import { commitCredits, lockWallet, purchasableOptions, readWallet, reserveCredits } from "./wallet.js";

// STORY-046 AC3 — a debit whose amount is known only INSIDE the handler.
//
// `CreditGuard` + `CreditInterceptor` are the path for a FLAT price, quoted
// before the handler runs and echoed back in `X-Nominara-Confirmed-Credits`.
// A prompt activation is not that: what it costs depends on which of the named
// prompts are new to the project and how many of the free ten are left, and
// both are decided from rows that are locked inside the request's own
// transaction. So the reserve and the commit happen HERE, in that transaction,
// and the pair is one atomic decision:
//
//   * a refusal (402) rolls the whole request back, so a refused activation
//     leaves no reserve, no release, no wallet movement and no activated
//     prompt - nothing to reconcile;
//   * a success commits the debit and the activation together, so there is no
//     window in which the customer was charged for prompts that did not turn on.
//
// The ledger rules are the guard's and the interceptor's, unchanged: the wallet
// statement runs BEFORE the ledger append (replay's ordering is only sound with
// the wallet row lock already held - see `appendLedgerEntry`), a refused append
// is a defect and throws, and the entry pair carries the idempotency key.

/**
 * The plan's included grant, for a wallet that does not exist yet.
 *
 * Zero when the plan does not publish one: a wallet provisioned at zero
 * refuses correctly, where guessing a figure would hand out credits.
 */
export function includedGrantOf(entitlements: Readonly<Record<string, { readonly value: unknown } | undefined>>): number {
  const value = entitlements["credits.included_per_cycle"]?.value;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

export interface InlineDebit {
  readonly workspaceId: string;
  readonly actorId: string | null;
  readonly actorType: "user" | "api_key" | "system";
  readonly actionCode: LedgerActionCode;
  /** A positive whole number. A zero debit is not a debit and writes nothing - callers skip it. */
  readonly credits: number;
  /**
   * Must identify THIS decision. `ux_credit_ledger_idem` makes a repeat of it a
   * refused append, which throws and rolls the transaction back rather than
   * charging twice.
   */
  readonly idempotencyKey: string;
  readonly projectId?: string;
  readonly unitDetail?: LedgerUnitDetail;
  /** The plan's `credits.included_per_cycle`, for a workspace whose wallet does not exist yet. */
  readonly includedGrant: number;
}

/** A key that is stable for a set of ids regardless of the order they were named in. */
export function idempotencyKeyFor(prefix: string, scope: string, ids: readonly string[]): string {
  const digest = createHash("sha256").update([...ids].sort().join(",")).digest("hex");
  return `${prefix}:${scope}:${digest}`;
}

/**
 * Reserve and commit `credits` in the ambient transaction.
 *
 * Throws `InsufficientCreditsError` (402) when the wallet cannot cover it.
 * The caller is in a tenant transaction, so the throw rolls everything back -
 * including a wallet row this call provisioned.
 */
export async function debitInTransaction(tx: ClientBase, debit: InlineDebit): Promise<void> {
  if (!Number.isInteger(debit.credits) || debit.credits <= 0) {
    throw new Error(`an inline debit must be a positive whole number of credits, got ${String(debit.credits)}`);
  }

  const period = await resolveBillingPeriod(tx, debit.workspaceId);
  await provisionWalletWithGrant(tx, debit.workspaceId, debit.includedGrant, period);
  if (!(await lockWallet(tx, debit.workspaceId))) {
    throw new Error(`workspace ${debit.workspaceId} has no credit wallet after provisioning`);
  }

  const reserved = await reserveCredits(tx, debit.workspaceId, debit.credits);
  if (!reserved.ok || reserved.wallet === null) {
    const wallet = await readWallet(tx, debit.workspaceId);
    if (wallet === null) throw new Error(`workspace ${debit.workspaceId} has no credit wallet after provisioning`);
    throw new InsufficientCreditsError({
      message: "Your scheduled tracking is unaffected and keeps running. This on-demand action needs more credits than the wallet has.",
      details: {
        required: debit.credits,
        available: wallet.available,
        wallet: {
          included_balance: wallet.includedBalance,
          purchased_balance: wallet.purchasedBalance,
          reserved: wallet.reserved,
          cycle_end: wallet.cycleEnd,
        },
        packs: (await purchasableOptions(tx, debit.workspaceId)).map((pack) => ({
          key: pack.key,
          credits: pack.credits,
          price_usd: pack.priceUsd,
        })),
      },
    });
  }

  const common = {
    workspaceId: debit.workspaceId,
    actionCode: debit.actionCode,
    credits: debit.credits,
    idempotencyKey: debit.idempotencyKey,
    attempt: 1,
    actorId: debit.actorId,
    actorType: debit.actorType,
    // Both halves name the project: unlike the guard, which reserves before the
    // handler has resolved what the request is about, this caller already knows.
    ...(debit.projectId === undefined ? {} : { projectId: debit.projectId }),
  } as const;

  if (!(await appendLedgerEntry(tx, { ...common, entryType: "reserve", after: reserved.wallet }))) {
    throw new Error(`the ledger already holds a reserve under ${debit.idempotencyKey}; refusing to charge twice`);
  }

  const committed = await commitCredits(tx, debit.workspaceId, debit.credits, debit.credits);
  if (committed === null) {
    throw new Error(`credit commit matched no wallet row for workspace ${debit.workspaceId} (${debit.idempotencyKey})`);
  }

  if (
    !(await appendLedgerEntry(tx, {
      ...common,
      entryType: "commit",
      after: committed,
      ...(debit.unitDetail === undefined ? {} : { unitDetail: debit.unitDetail }),
    }))
  ) {
    throw new Error(`the ledger already holds a commit under ${debit.idempotencyKey}; refusing to charge twice`);
  }
}
