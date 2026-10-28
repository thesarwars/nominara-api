import type { ClientBase } from "pg";
import { grantCredits, provisionWalletWithGrant } from "../../../lib/credits/balance.js";
import { readWallet } from "../../../lib/credits/wallet.js";
import { structuralLimitFrom } from "../../../lib/entitlements/classification.js";
import { resolveEntitlements } from "../../../lib/entitlements/resolution.js";
import { PROMPT_OCCUPIES_SLOT } from "../../../lib/entitlements/structural-usage.js";
import { nextRunAfter } from "../../../lib/capture/scheduler.js";
import { startingCadenceFor } from "../../../lib/capture/starting-cadence.js";
import { uuidV7 } from "../../../lib/ids/uuidv7.js";
import { promptTextHash } from "../../../lib/promptgen/text-hash.js";
import { resolveBillingPeriod } from "../../../lib/usage/billing-period.js";
import { AuditChainService } from "../../../modules/audit/audit-chain.service.js";
import type { DekProvisioner } from "../../../modules/workspaces/ports/dek-provisioner.js";
import { SYSTEM_ACTOR_ID } from "../../../tenancy/constants.js";
import { withTenantContext } from "../../../tenancy/tenant-context.js";
import type { EntitlementValue } from "../plan-entitlements.js";
import { assertPooledConnectionIsRuntimeApp } from "../runtime-role.js";
import {
  SYNTHETIC_GRANT_AUDIT_ACTION,
  SYNTHETIC_GRANT_CREDITS,
  SYNTHETIC_GRANT_IDEMPOTENCY_KEY,
  SYNTHETIC_SEED_MARKER,
  SYNTHETIC_SEED_MARKER_KEY,
  SYNTHETIC_TENANTS,
  type SyntheticPaidPlan,
  type SyntheticProject,
  type SyntheticTenant,
} from "./constants.js";

// STORY-004 AC5 — writes the three synthetic tenants (constants.ts), and on a
// second run writes nothing.
//
// EVERY WRITE GOES THROUGH `nominara_app` INSIDE `withTenantContext`, never the
// owner connection: RLS is the boundary, not a convention. The first statement
// of every transaction is `assertPooledConnectionIsRuntimeApp`, so a
// DATABASE_URL_POOLED that names a superuser is refused before any row.
//
// Per tenant, three steps, in this order on purpose:
//   1. one transaction: the owner user (reused if the address already has an active or unverified
//      account), and — only when the workspace row does not exist — the
//      workspace, its DEK, the owner membership and the starting `free`
//      subscription, audited `workspace.created`. This is the row set
//      `WorkspacesService.create` writes (STORY-021), minus the HTTP layer.
//   2. the plan, through the REAL `plan:set` operator CLI (`setPlan`), and
//      only when the workspace is not already on it. The CLI is run, never
//      imported: test/unit/billing/plan-change-import-surface.spec.ts allows
//      exactly two importers of the plan write, and this is not one of them.
//      Running the CLI is what an operator does; it audits
//      `workspace.plan_changed` itself.
//   3. one transaction, now that the paid tier's entitlements apply: the
//      projects, prompts and competitors, then the wallet and the fixed
//      500-credit grant through `grantCredits` under
//      `SYNTHETIC_GRANT_IDEMPOTENCY_KEY` (a re-run finds the entry and moves
//      nothing), audited `billing.seed_credits_granted` only when it applied.
//      The wallet comes AFTER the plan so `applyPlanChange` finds no wallet
//      and mints no pro-rata top-up: the tenant holds exactly the fixed grant.
//
// No step makes a network call (ADR-0003): the DEK is wrapped in process, and
// the CLI runs between the two transactions, never inside one.

export interface SyntheticSeedPoolClient extends ClientBase {
  release(): void;
}
export interface SyntheticSeedPool {
  connect(): Promise<SyntheticSeedPoolClient>;
}

/** Puts a workspace on a plan through the real operator path. See `planSetViaCli`. */
export type SetPlan = (workspaceId: string, planKey: SyntheticPaidPlan) => Promise<void>;

export interface SyntheticSeedDeps {
  /** DATABASE_URL_POOLED — `nominara_app` through pgBouncer. Every write goes through here. */
  readonly pool: SyntheticSeedPool;
  readonly dekProvisioner: DekProvisioner;
  readonly setPlan: SetPlan;
  readonly log: (line: string) => void;
}

export interface SyntheticTenantOutcome {
  readonly key: SyntheticTenant["key"];
  readonly workspaceId: string;
  readonly workspaceCreated: boolean;
  readonly planChanged: boolean;
  readonly granted: boolean;
  readonly projectsCreated: number;
  readonly promptsCreated: number;
  readonly competitorsCreated: number;
}

export class SyntheticSeedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SyntheticSeedError";
  }
}

const SEED_WHAT = "synthetic tenants";
const SEED_REQUEST_ID = "seed:synthetic";
const SEED_USER_AGENT = "seed:synthetic (pnpm db:seed)";
const PROJECTS_PROMPTS_CAP_COLUMN_MAX = 32_767;

async function inTenant<T>(pool: SyntheticSeedPool, workspaceId: string, fn: (tx: ClientBase) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      await assertPooledConnectionIsRuntimeApp(tx, SEED_WHAT);
      return fn(tx);
    });
  } finally {
    client.release();
  }
}

/** Account statuses the seed may attach an owner membership to: the account sign-in creates, and an active one. */
const REUSABLE_OWNER_STATUSES: readonly string[] = ["active", "unverified"];

/**
 * The account at the owner address: reused when one exists and is `active` or `unverified` (the row email-OTP
 * sign-up leaves), created active and verified otherwise. A `suspended` (or `deleted`) account is REFUSED: the seed
 * must not hand a workspace to an account an operator has shut.
 */
async function ensureOwnerUser(tx: ClientBase, email: string): Promise<string> {
  await tx.query(
    `INSERT INTO users (id, email, status, email_verified_at) VALUES ($1, $2, 'active', now())
     ON CONFLICT (email) WHERE deleted_at IS NULL DO NOTHING`,
    [uuidV7(), email],
  );
  const result = await tx.query<{ id: string; status: string }>(`SELECT id, status FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]);
  const row = result.rows[0];
  if (row === undefined) throw new SyntheticSeedError(`could not resolve the owner account for ${email}`);
  if (!REUSABLE_OWNER_STATUSES.includes(row.status)) {
    throw new SyntheticSeedError(
      `the account at ${email} is ${row.status}; the seed attaches a workspace only to an active or unverified account. ` +
        "Run `pnpm db:reset --seed` to start over.",
    );
  }
  return row.id;
}

/** Step 1. Returns whether the workspace row was created by THIS run. */
async function ensureWorkspace(tx: ClientBase, tenant: SyntheticTenant, dekProvisioner: DekProvisioner): Promise<boolean> {
  const ownerId = await ensureOwnerUser(tx, tenant.ownerEmail);

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO workspaces (id, name, slug, org_type, region, timezone, plan_key)
     VALUES ($1, $2, $3, 'in_house', 'us-east-1', 'UTC', 'free')
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [tenant.workspaceId, tenant.name, tenant.slug],
  );
  if (inserted.rows.length === 0) return false;

  const dek = await dekProvisioner.provision(tenant.workspaceId);
  await tx.query(`INSERT INTO workspace_keys (id, workspace_id, dek_id, wrapped_dek, kms_key_arn) VALUES ($1,$2,$3,$4,$5)`, [
    uuidV7(),
    tenant.workspaceId,
    dek.dekId,
    dek.wrappedDek,
    dek.kmsKeyArn,
  ]);

  try {
    await tx.query(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'owner','active')`, [
      uuidV7(),
      tenant.workspaceId,
      ownerId,
    ]);
  } catch (error) {
    const pg = error as { code?: string; constraint?: string };
    if (pg.code === "23505" && pg.constraint === "ux_one_owned_workspace_per_user") {
      throw new SyntheticSeedError(
        `${tenant.ownerEmail} already owns another workspace, and an account may own only one. ` +
          "Delete that workspace (or run `pnpm db:reset`) and seed again.",
        { cause: error },
      );
    }
    throw error;
  }

  // The starting subscription WorkspacesService.create writes (STORY-021-E-1/E-2): free, active, local placeholders.
  await tx.query(
    `INSERT INTO subscriptions
       (id, workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id,
        status, current_period_start, current_period_end, trial_ends_at)
     VALUES ($1,$2,'free','monthly',$3,$4,'active', now(), now() + interval '1 month', NULL)`,
    [uuidV7(), tenant.workspaceId, `local_cus_${tenant.workspaceId}`, `local_sub_${tenant.workspaceId}`],
  );

  await new AuditChainService().append(tx, {
    workspaceId: tenant.workspaceId,
    actorType: "system",
    actorId: SYSTEM_ACTOR_ID,
    actorIp: null,
    actorUa: SEED_USER_AGENT,
    action: "workspace.created",
    resourceType: "workspace",
    resourceId: tenant.workspaceId,
    beforeState: null,
    afterState: { name: tenant.name, slug: tenant.slug, plan_key: "free", owner_user_id: ownerId, [SYNTHETIC_SEED_MARKER_KEY]: SYNTHETIC_SEED_MARKER },
    requestId: SEED_REQUEST_ID,
    supportGrantId: null,
    severity: "info",
  });
  return true;
}

async function currentPlan(tx: ClientBase, workspaceId: string): Promise<string> {
  const result = await tx.query<{ plan_key: string }>(`SELECT plan_key FROM workspaces WHERE id = $1`, [workspaceId]);
  const row = result.rows[0];
  if (row === undefined) throw new SyntheticSeedError(`workspace ${workspaceId} is not visible to its own tenant context`);
  return row.plan_key;
}

/** A finite structural limit from the resolved entitlements; unlimited reads as the column maximum. Never a hardcoded number. */
function limitOf(entitlements: Readonly<Record<string, { readonly value: unknown } | undefined>>, key: string): number {
  const limit = structuralLimitFrom((entitlements[key]?.value ?? null) as EntitlementValue);
  if (limit === undefined) return 0;
  return limit.kind === "unlimited" ? Number.POSITIVE_INFINITY : limit.limit;
}

interface ProjectCounts {
  readonly projectsCreated: number;
  readonly promptsCreated: number;
  readonly competitorsCreated: number;
}

async function ensureProject(
  tx: ClientBase,
  workspaceId: string,
  project: SyntheticProject,
  entitlements: Readonly<Record<string, { readonly value: unknown } | undefined>>,
): Promise<ProjectCounts> {
  const cadence = startingCadenceFor(entitlements["scan.cadence"]?.value);
  const created = await tx.query<{ id: string }>(
    `INSERT INTO projects
       (id, workspace_id, name, slug, root_url, root_domain, brand_aliases, status, fingerprint, created_by, cadence, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::text[],'active',$8::jsonb,$9,$10,$11)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      project.id,
      workspaceId,
      project.name,
      project.slug,
      `https://${project.rootDomain}`,
      project.rootDomain,
      [...project.brandAliases],
      JSON.stringify({ [SYNTHETIC_SEED_MARKER_KEY]: SYNTHETIC_SEED_MARKER }),
      SYSTEM_ACTOR_ID,
      cadence,
      // Owner decision 2026-10-09 pm #1/#2 (the demo seed's rule): active on the plan's starting cadence, next slot, never "now".
      nextRunAfter(cadence, new Date()),
    ],
  );
  const projectCreated = created.rows.length > 0;

  let promptsCreated = 0;
  for (const prompt of project.prompts) {
    // Activated-and-free, as the demo seed writes them (STORY-046 AC3): the charge rule always has a fact.
    // text_hash is sha256(normalise(text)) (schemas/projects-and-prompts.md), computed by the ONE implementation the
    // API's dedupe uses, so the same question added through the API dedupes against a seeded row.
    const inserted = await tx.query(
      `INSERT INTO tracked_prompts
         (id, workspace_id, project_id, generation_source, text, text_hash, intent_archetype, funnel_stage, status, generator_meta,
          first_activated_at, activation_credits)
       VALUES ($1,$2,$3,'manual',$4,$5,$6,$7,'active',$8::jsonb, now(), 0)
       ON CONFLICT (project_id, text_hash) WHERE deleted_at IS NULL DO NOTHING`,
      [
        uuidV7(),
        workspaceId,
        project.id,
        prompt.text,
        promptTextHash(prompt.text).bytes,
        prompt.intentArchetype,
        prompt.funnelStage,
        JSON.stringify({ [SYNTHETIC_SEED_MARKER_KEY]: SYNTHETIC_SEED_MARKER }),
      ],
    );
    promptsCreated += inserted.rowCount ?? 0;
  }

  if (projectCreated || promptsCreated > 0) {
    // The denormalised slot columns move in the same transaction as the prompts (activation.service.ts's rule).
    const perProjectCap = Math.min(limitOf(entitlements, "prompts.max_per_project"), PROJECTS_PROMPTS_CAP_COLUMN_MAX);
    await tx.query(
      `UPDATE projects
          SET prompts_active = (SELECT count(*) FROM tracked_prompts WHERE project_id = $1 AND ${PROMPT_OCCUPIES_SLOT}),
              prompts_cap = $2,
              updated_at = now()
        WHERE id = $1`,
      [project.id, perProjectCap],
    );
  }

  // One statement per competitor, against ux_competitors_project_name (project_id, lower(name)) WHERE deleted_at IS
  // NULL: a concurrent seed's uncommitted row makes this insert WAIT, and once it commits this one does nothing, where
  // a SELECT-then-INSERT failed on the unique index.
  let competitorsCreated = 0;
  for (const [index, competitor] of project.competitors.entries()) {
    const inserted = await tx.query(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source, is_primary)
       VALUES ($1,$2,$3,$4,$5,ARRAY[]::text[],'user',$6)
       ON CONFLICT (project_id, lower(name)) WHERE deleted_at IS NULL DO NOTHING`,
      [uuidV7(), workspaceId, project.id, competitor.name, competitor.rootDomain, index === 0],
    );
    competitorsCreated += inserted.rowCount ?? 0;
  }

  return { projectsCreated: projectCreated ? 1 : 0, promptsCreated, competitorsCreated };
}

/** Step 3's credit half. Returns whether the grant was applied by THIS run. */
async function ensureGrant(tx: ClientBase, workspaceId: string): Promise<boolean> {
  if ((await readWallet(tx, workspaceId)) === null) {
    // A bare wallet (grant 0 writes no ledger entry), so the tenant holds exactly the fixed grant below.
    await provisionWalletWithGrant(tx, workspaceId, 0, await resolveBillingPeriod(tx, workspaceId));
  }
  const outcome = await grantCredits(
    tx,
    { workspaceId, idempotencyKey: SYNTHETIC_GRANT_IDEMPOTENCY_KEY, actorId: null, actorType: "system" },
    SYNTHETIC_GRANT_CREDITS,
  );
  if (!outcome.applied) return false;

  await new AuditChainService().append(tx, {
    workspaceId,
    actorType: "system",
    actorId: SYSTEM_ACTOR_ID,
    actorIp: null,
    actorUa: SEED_USER_AGENT,
    action: SYNTHETIC_GRANT_AUDIT_ACTION,
    resourceType: "workspace",
    resourceId: workspaceId,
    beforeState: null,
    afterState: {
      credits: SYNTHETIC_GRANT_CREDITS,
      bucket: "included",
      idempotency_key: SYNTHETIC_GRANT_IDEMPOTENCY_KEY,
      available_after: outcome.wallet?.available ?? null,
    },
    requestId: SEED_REQUEST_ID,
    supportGrantId: null,
    severity: "notice",
  });
  return true;
}

async function seedTenant(tenant: SyntheticTenant, deps: SyntheticSeedDeps): Promise<SyntheticTenantOutcome> {
  const { pool, dekProvisioner, setPlan, log } = deps;

  const { workspaceCreated, planBefore } = await inTenant(pool, tenant.workspaceId, async (tx) => {
    const created = await ensureWorkspace(tx, tenant, dekProvisioner);
    return { workspaceCreated: created, planBefore: await currentPlan(tx, tenant.workspaceId) };
  });

  const planChanged = planBefore !== tenant.planKey;
  if (planChanged) {
    await setPlan(tenant.workspaceId, tenant.planKey);
  }

  return inTenant(pool, tenant.workspaceId, async (tx) => {
    const planAfter = await currentPlan(tx, tenant.workspaceId);
    if (planAfter !== tenant.planKey) {
      // Concatenation, not a template literal: a literal opening with an interpolation and a colon reads to ISO-13's
      // cache-key scanner as an un-namespaced key construction site.
      throw new SyntheticSeedError(tenant.key + ": expected plan " + tenant.planKey + " after plan:set, found " + planAfter);
    }
    const { entitlements } = await resolveEntitlements(tx, tenant.workspaceId);
    let projectsCreated = 0;
    let promptsCreated = 0;
    let competitorsCreated = 0;
    for (const project of tenant.projects) {
      const counts = await ensureProject(tx, tenant.workspaceId, project, entitlements);
      projectsCreated += counts.projectsCreated;
      promptsCreated += counts.promptsCreated;
      competitorsCreated += counts.competitorsCreated;
    }
    const granted = await ensureGrant(tx, tenant.workspaceId);

    // Plain variables, never a ternary inside a template literal that opens with an interpolation: ISO-13's cache-key
    // scanner reads raw source and counts the ternary's colon as a key separator (see runtime-role.ts).
    const workspaceNote = workspaceCreated ? "created" : "already present";
    const planNote = planChanged ? "set " + planBefore + " -> " + tenant.planKey : "unchanged";
    const grantNote = granted ? String(SYNTHETIC_GRANT_CREDITS) + "-credit grant applied" : "grant already recorded";
    log(
      "tenant " + tenant.key + " (" + tenant.ownerEmail + ", " + tenant.planKey + "): workspace " + workspaceNote +
        ", plan " + planNote + ", " + String(projectsCreated) + " project(s), " + String(promptsCreated) + " prompt(s), " +
        String(competitorsCreated) + " competitor(s) created, " + grantNote,
    );
    return {
      key: tenant.key,
      workspaceId: tenant.workspaceId,
      workspaceCreated,
      planChanged,
      granted,
      projectsCreated,
      promptsCreated,
      competitorsCreated,
    };
  });
}

/** Seeds every tenant in `SYNTHETIC_TENANTS`, in order. Idempotent. */
export async function runSyntheticSeed(deps: SyntheticSeedDeps): Promise<SyntheticTenantOutcome[]> {
  const outcomes: SyntheticTenantOutcome[] = [];
  for (const tenant of SYNTHETIC_TENANTS) {
    outcomes.push(await seedTenant(tenant, deps));
  }
  return outcomes;
}
