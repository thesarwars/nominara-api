import { fileURLToPath } from "node:url";
import type { ClientBase, PoolClient } from "pg";
import { loadEnv } from "../../config/env.js";
import { createPgPool } from "../../db/pg-pool.js";
import { applyPlanChange, planKeyOnly, type BillingInterval } from "../../lib/billing/apply-plan.js";
import { lockWorkspaceBounded } from "../../lib/billing/workspace-lock.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";

// STORY-151 — the ONLY thing in this repository that can change a workspace's
// plan, and it is a script an operator runs, not a route a customer reaches.
//
// ⚠ IF THIS FILE EVER BECOMES A NEST PROVIDER, THE SAFETY PROPERTY IS GONE.
// A @Injectable, @Controller or @Module would put `applyPlanChange` in the
// injector, and the injector is reachable from a request.
// test/unit/billing/plan-change-import-surface.spec.ts asserts all three.
//
// Shaped on src/workers/rollup/credit-reconcile.ts: `main()` guarded by the
// entry-point check, `process.exitCode` rather than `process.exit`, and all
// the logic in the shared lib so the script is argument parsing and printing.
//
// Usage:
//   pnpm plan:set --workspace <uuid> --plan <starter|growth|business> \
//                 --operator <who> --ticket <ref> --reason <text> \
//                 [--interval monthly|annual] [--allow-negotiated-tier]

/** `free` is where every workspace starts, and going back is a DOWNGRADE (STORY-077). */
const GRANTABLE = new Set(["starter", "growth", "business"]);
/** Priced by contract, resolves to unlimited. Needs a second, deliberate flag. */
const NEGOTIATED = new Set(["enterprise"]);

export interface PlanSetArgs {
  readonly workspaceId: string;
  readonly planKey: string;
  readonly operator: string;
  readonly ticket: string;
  readonly reason: string;
  readonly billingInterval?: BillingInterval;
  readonly allowNegotiatedTier: boolean;
}

export class PlanSetUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanSetUsageError";
  }
}

/**
 * Exported so the refusals are testable without a database.
 *
 * ⚠ EVERY FLAG IS MANDATORY, INCLUDING THE PROSE ONES. `--operator`,
 * `--ticket` and `--reason` all land on a hash-chained audit row, and an
 * upgrade nobody can attribute afterwards is the thing this story is trying
 * not to create. Making them optional would make them absent.
 */
export function parsePlanSetArgs(argv: readonly string[]): PlanSetArgs {
  const flags = new Map<string, string>();
  let allowNegotiatedTier = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    if (token === "--allow-negotiated-tier") {
      allowNegotiatedTier = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new PlanSetUsageError(`${token} needs a value`);
    flags.set(token.slice(2), value);
    i += 1;
  }

  const required = ["workspace", "plan", "operator", "ticket", "reason"] as const;
  const missing = required.filter((name) => (flags.get(name) ?? "").trim() === "");
  if (missing.length > 0) {
    throw new PlanSetUsageError(`missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}`);
  }

  const planKey = flags.get("plan")!;
  // ⚠ REFUSED AT PARSING, BEFORE ANY CODE RUNS. The service refuses these
  // again under the row lock — a plan's `sort_order` is data and can be
  // reseeded — but a typo should not need a database round trip to be caught.
  if (planKey === "free") {
    throw new PlanSetUsageError(
      "refusing --plan free: every workspace starts there, and going back is a downgrade. STORY-077 owns downgrades",
    );
  }
  if (NEGOTIATED.has(planKey) && !allowNegotiatedTier) {
    throw new PlanSetUsageError(
      `refusing --plan ${planKey}: it resolves to UNLIMITED and is priced by contract. ` +
        "Pass --allow-negotiated-tier as well, deliberately, with the ticket that authorises it",
    );
  }
  if (!GRANTABLE.has(planKey) && !NEGOTIATED.has(planKey)) {
    throw new PlanSetUsageError(`unknown --plan ${planKey}: grantable plans are ${[...GRANTABLE].join(", ")}`);
  }

  const interval = flags.get("interval");
  if (interval !== undefined && interval !== "monthly" && interval !== "annual") {
    throw new PlanSetUsageError(`--interval must be monthly or annual, got ${interval}`);
  }

  return {
    workspaceId: flags.get("workspace")!,
    planKey,
    operator: flags.get("operator")!,
    ticket: flags.get("ticket")!,
    reason: flags.get("reason")!,
    ...(interval === undefined ? {} : { billingInterval: interval }),
    allowNegotiatedTier,
  };
}

/** The operator CLI refused: the workspace is billed through Stripe. */
export class PlanSetStripeTrackedError extends Error {
  constructor(workspaceId: string, planKey: string) {
    super(
      `refusing: workspace ${workspaceId} is billed through Stripe (live subscription on '${planKey}'). ` +
        "A comp written over a Stripe-tracked subscription is not recorded anywhere Stripe can see, and the webhook would then refuse every " +
        "later event for it as a relabel. Change the plan in Stripe (the customer's in-app plan change, or the Dashboard with the " +
        "subscription's own metadata) or cancel the subscription first; plan:set is for workspaces with no live Stripe subscription",
    );
    this.name = "PlanSetStripeTrackedError";
  }
}

/**
 * STORY-184 (owner decision 2026-10-16) - `plan:set` is BLOCKED on a workspace whose subscription is Stripe-tracked
 * (`provider = 'stripe'`) and not ended. Ended means the webhook reconciled it to `free` (the row keeps `provider = stripe` and
 * the customer link, so a re-subscribe works): a comp there is allowed. Run inside the same tenant-context transaction as the
 * plan write, so the answer and the write cannot be separated by a webhook.
 */
export async function assertNotStripeTracked(tx: ClientBase, workspaceId: string): Promise<void> {
  // ⚠ THE WORKSPACE ROW LOCK FIRST (the same lock the webhook and every billing write take), so the answer cannot be separated from
  // the plan write by a webhook adopting a Stripe subscription between the check and the write. Bounded: a holder inside a Stripe
  // call makes this a clear refusal, not a hang.
  await lockWorkspaceBounded(tx, workspaceId, () => new Error(`workspace ${workspaceId} is busy with another billing change: retry shortly`));
  const result = await tx.query<{ plan_key: string }>(
    "SELECT plan_key FROM subscriptions WHERE workspace_id = $1 AND provider = 'stripe' AND status IN ('trialing','active','past_due') AND plan_key <> 'free'",
    [workspaceId],
  );
  const row = result.rows[0];
  if (row !== undefined) throw new PlanSetStripeTrackedError(workspaceId, row.plan_key);
}

/** Its own context-carrying transaction: `workspace_members` is a tenant table. */
async function activeMemberCount(client: PoolClient, workspaceId: string): Promise<string> {
  const rows = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
    tx.query<{ count: string }>(
      "SELECT count(*) AS count FROM workspace_members WHERE workspace_id = $1 AND status = 'active'",
      [workspaceId],
    ),
  );
  return rows.rows[0]?.count ?? "?";
}

export async function runPlanSet(args: PlanSetArgs, log: (line: string) => void = console.log): Promise<void> {
  const env = loadEnv();
  // The same role and the same tenant context an ordinary request uses. The
  // operator's privilege is possession of the shell and the connection
  // string, not a database role — which is what lets STORY-075's webhook
  // handler execute this byte-identically.
  const pool = createPgPool(env.DATABASE_URL_POOLED);
  try {
    const client = await pool.connect();
    try {
      const outcome = await withTenantContext(
        client,
        { workspaceId: args.workspaceId, actorId: SYSTEM_ACTOR_ID },
        async (tx) => {
          await assertNotStripeTracked(tx, args.workspaceId);
          return await applyPlanChange(
            tx,
            args.workspaceId,
            planKeyOnly(args.planKey, args.billingInterval),
            { requestId: args.ticket, operator: args.operator, reason: args.reason },
            { allowNegotiatedTier: args.allowNegotiatedTier },
          );
        },
      );

      if (!outcome.changed) {
        log(`no change: ${args.workspaceId} is already on ${outcome.to}. Nothing written, no tokens invalidated.`);
        return;
      }

      log(`${args.workspaceId}: ${outcome.from} -> ${outcome.to}`);
      log(`entitlement_version now ${String(outcome.entitlementVersion)}`);
      log(
        outcome.creditsToppedUp > 0
          ? `credits topped up pro rata: +${String(outcome.creditsToppedUp)}`
          : `credits topped up: 0${outcome.creditsNote === undefined ? "" : ` (${outcome.creditsNote})`}`,
      );
      // ⚠ SAID OUT LOUD, BECAUSE IT SURPRISES PEOPLE. The version bump is a
      // workspace-wide soft logout: every member's live token now fails
      // `entitlement_stale` until their client re-enters the workspace.
      //
      // ⚠ AND IT NEEDS ITS OWN TENANT CONTEXT. The first version ran this on
      // `client` AFTER `withTenantContext` had returned — and `createPgPool`
      // wraps the pool in `tenantAwarePool` while `workspace_members` is a
      // TENANT_TABLE, so every single invocation printed success, then threw
      // `TenantContextMissingError`, then exited 1. The plan change had
      // already committed, so an operator reasonably re-running it got a
      // no-op — correct by luck rather than by design.
      log(`${await activeMemberCount(client, args.workspaceId)} active member(s) must re-enter the workspace; their live tokens are now stale.`);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  try {
    await runPlanSet(parsePlanSetArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
