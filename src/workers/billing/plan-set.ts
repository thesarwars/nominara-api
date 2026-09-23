import { fileURLToPath } from "node:url";
import { loadEnv } from "../../config/env.js";
import { createPgPool } from "../../db/pg-pool.js";
import { applyPlanChange, planKeyOnly, type BillingInterval } from "../../lib/billing/apply-plan.js";
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
        (tx) =>
          applyPlanChange(
            tx,
            args.workspaceId,
            planKeyOnly(args.planKey, args.billingInterval),
            { requestId: args.ticket, operator: args.operator, reason: args.reason },
            { allowNegotiatedTier: args.allowNegotiatedTier },
          ),
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
      const members = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM workspace_members WHERE workspace_id = $1 AND status = 'active'",
        [args.workspaceId],
      );
      log(`${members.rows[0]?.count ?? "?"} active member(s) must re-enter the workspace; their live tokens are now stale.`);
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
