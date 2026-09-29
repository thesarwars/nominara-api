import type { ClientBase } from "pg";
import { provisionWalletWithGrant } from "../../../lib/credits/balance.js";
import { readWallet } from "../../../lib/credits/wallet.js";
import { resolveEntitlements } from "../../../lib/entitlements/resolution.js";
import { resolveBillingPeriod } from "../../../lib/usage/billing-period.js";

// STORY-169 — provision a workspace's wallet ONLY through the real
// `resolveBillingPeriod` + `provisionWalletWithGrant` pair, exactly the path
// `CreditGuard` takes on a workspace's first priced request. Never an
// invented balance, and never a direct `INSERT INTO credit_wallets` — that
// would mint credits with no `credit_ledger` entry, the exact defect
// `provisionWalletWithGrant`'s own header describes fixing.
//
// ⚠ NOT REVERSIBLE. `credit_ledger` is append-only (a DB trigger refuses an
// UPDATE/DELETE), so once this runs, the grant entry it wrote is there for
// good — `--purge` does not touch the wallet or the ledger, and says so.

/** Same rule `CreditGuard`'s private `includedGrantOf` applies: zero when the plan publishes none, never a guess. */
function includedGrantOf(entitlements: Readonly<Record<string, { readonly value: unknown }>>): number {
  const value = entitlements["credits.included_per_cycle"]?.value;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

export interface EnsureWalletResult {
  /** A NEW wallet row now exists that did not before this call — true even when `grant` is 0. */
  readonly provisioned: boolean;
  readonly grant: number;
}

/**
 * Provisions a wallet if the workspace has none. Idempotent: a workspace
 * that already has one is untouched. Must run inside `withTenantContext`.
 *
 * ⚠ REVIEW FIX — `provisioned` is `outcome.wallet !== null`, NOT
 * `outcome.applied`. `provisionWalletWithGrant` (balance.ts) returns
 * `applied: false` whenever `grant === 0`, EVEN THOUGH IT STILL CREATES THE
 * WALLET (`created`) — `applied` there means "a ledger entry was written",
 * which a zero grant correctly never needs, not "nothing changed". Reading
 * `outcome.applied` as "provisioned" made a real, irreversible wallet
 * creation on a zero-grant plan log as "workspace already has a wallet —
 * left untouched." (`seed-demo.ts`), which is false: the wallet did not
 * exist a moment before, and it does now.
 */
export async function ensureDemoWallet(tx: ClientBase, workspaceId: string): Promise<EnsureWalletResult> {
  const existing = await readWallet(tx, workspaceId);
  if (existing !== null) {
    return { provisioned: false, grant: 0 };
  }

  const resolved = await resolveEntitlements(tx, workspaceId);
  const grant = includedGrantOf(resolved.entitlements);
  const period = await resolveBillingPeriod(tx, workspaceId);
  const outcome = await provisionWalletWithGrant(tx, workspaceId, grant, period);

  return { provisioned: outcome.wallet !== null, grant };
}
