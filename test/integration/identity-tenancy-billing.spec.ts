import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// STORY-007 · DDL 1: identity, tenancy, billing catalog. Same pattern as
// STORY-006's suite: one shared container, hard schema reset per test.
describe("STORY-007 · identity, tenancy & billing DDL", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client);
    seq = 0;
  });

  afterEach(async () => {
    await client.end();
  });

  // ---- helpers -------------------------------------------------------

  async function createWorkspace(c: Client = client, planKey = "free"): Promise<string> {
    seq += 1;
    const result = await c.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, $3) RETURNING id",
      [`Workspace ${seq}`, `workspace-${seq}-${Math.random().toString(36).slice(2)}`, planKey],
    );
    return result.rows[0]!.id;
  }

  async function createUser(c: Client = client): Promise<string> {
    seq += 1;
    const result = await c.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`user-${seq}-${Math.random().toString(36).slice(2)}@example.com`],
    );
    return result.rows[0]!.id;
  }

  async function addMember(
    c: Client,
    workspaceId: string,
    userId: string,
    role: string,
    status = "active",
  ) {
    return c.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, $3, $4)", [
      workspaceId,
      userId,
      role,
      status,
    ]);
  }

  async function createWallet(
    c: Client,
    workspaceId: string,
    overrides: Partial<{
      included: number;
      purchased: number;
      reserved: number;
      autoTopupEnabled: boolean;
      autoTopupPackKey: string | null;
      autoTopupThreshold: number | null;
      autoTopupMaxPerCycle: number | null;
    }> = {},
  ) {
    const {
      included = 0,
      purchased = 0,
      reserved = 0,
      autoTopupEnabled = false,
      autoTopupPackKey = null,
      autoTopupThreshold = null,
      autoTopupMaxPerCycle = null,
    } = overrides;
    return c.query(
      `INSERT INTO credit_wallets
         (workspace_id, included_balance, purchased_balance, reserved, cycle_start, cycle_end,
          auto_topup_enabled, auto_topup_pack_key, auto_topup_threshold, auto_topup_max_per_cycle)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days', $5, $6, $7, $8)`,
      [workspaceId, included, purchased, reserved, autoTopupEnabled, autoTopupPackKey, autoTopupThreshold, autoTopupMaxPerCycle],
    );
  }

  async function insertLedgerEntry(
    c: Client,
    workspaceId: string,
    overrides: Partial<{ entryType: string; idempotencyKey: string; credits: number }> = {},
  ) {
    const { entryType = "grant", idempotencyKey = `idem-${Math.random().toString(36).slice(2)}`, credits = 10 } =
      overrides;
    return c.query(
      `INSERT INTO credit_ledger
         (workspace_id, entry_type, credits, included_after, purchased_after, reserved_after, idempotency_key)
       VALUES ($1, $2, $3, 0, 0, 0, $4)
       RETURNING id`,
      [workspaceId, entryType, credits, idempotencyKey],
    );
  }

  // ---- sanity: every table from both schema pages exists -------------

  it("every table from identity-and-tenancy.md and billing-and-credits.md exists", async () => {
    const expected = [
      "plans",
      "users",
      "user_credentials",
      "workspaces",
      "workspace_keys",
      "workspace_members",
      "workspace_invitations",
      "sso_configurations",
      "api_keys",
      "support_grants",
      "subscriptions",
      "credit_wallets",
      "credit_daily_counters",
      "credit_ledger",
      "credit_packs",
      "credit_purchases",
      "subscription_addons",
      "usage_counters",
      "usage_ledger",
      "invoices",
    ];
    const result = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    const actual = result.rows.map((r) => r.table_name);
    for (const table of expected) {
      expect(actual, `missing table: ${table}`).toContain(table);
    }
    expect(actual.length).toBe(expected.length);
  });

  it("the plans table is seeded with all five tiers from the entitlement matrix", async () => {
    const result = await client.query<{ key: string }>("SELECT key FROM plans ORDER BY sort_order");
    expect(result.rows.map((r) => r.key)).toEqual(["free", "starter", "growth", "business", "enterprise"]);
  });

  it("spot-checks column types and FK targets the table-name sanity check above cannot see", async () => {
    const columnType = async (table: string, column: string) => {
      // citext is an extension type, not a built-in one — information_schema
      // reports it as the generic "USER-DEFINED" in data_type; udt_name is
      // where the actual type name ("citext") shows up.
      const result = await client.query<{ udt_name: string }>(
        "SELECT udt_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
        [table, column],
      );
      return result.rows[0]?.udt_name;
    };

    // citext, not text — case-insensitive lookup is the whole point of these columns.
    expect(await columnType("users", "email")).toBe("citext");
    expect(await columnType("workspaces", "slug")).toBe("citext");

    // numeric(12,2), never float, for money — data-model.md's Money convention.
    const moneyPrecision = await client.query<{ numeric_precision: number; numeric_scale: number }>(
      "SELECT numeric_precision, numeric_scale FROM information_schema.columns WHERE table_name = 'plans' AND column_name = 'monthly_price'",
    );
    expect(moneyPrecision.rows[0]).toEqual({ numeric_precision: 12, numeric_scale: 2 });

    // workspaces.plan_key really targets plans(key), not just "some text column".
    const fk = await client.query<{ target: string }>(
      `SELECT confrelid::regclass::text AS target
       FROM pg_constraint
       WHERE conrelid = 'workspaces'::regclass AND conname LIKE '%plan_key%'`,
    );
    expect(fk.rows[0]?.target).toBe("plans");
  });

  // ---- scenario 1 ------------------------------------------------------

  it("scenario 1 — inserting two active owners for one workspace is rejected by the index", async () => {
    const workspaceId = await createWorkspace();
    const ownerA = await createUser();
    const ownerB = await createUser();

    await expect(addMember(client, workspaceId, ownerA, "owner")).resolves.toBeDefined();
    await expect(addMember(client, workspaceId, ownerB, "owner")).rejects.toThrow(/duplicate key/i);
  });

  // ---- scenario 2 ------------------------------------------------------

  it("scenario 2 — making one user the active owner of two workspaces is rejected by the index", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const owner = await createUser();

    await expect(addMember(client, workspaceA, owner, "owner")).resolves.toBeDefined();
    await expect(addMember(client, workspaceB, owner, "owner")).rejects.toThrow(/duplicate key/i);
  });

  // ---- scenario 3 ------------------------------------------------------

  it("scenario 3 — twenty concurrent owned-workspace creations for one user: exactly one succeeds", async () => {
    const owner = await createUser();
    // Sequential on purpose: a single pg.Client handles one in-flight query
    // at a time, so firing these concurrently on the shared setup client
    // would itself be the invalid-usage pattern this suite must not model.
    // The actual concurrency under test happens below, on 20 separate connections.
    const workspaceIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      workspaceIds.push(await createWorkspace());
    }

    // 20 real, separate connections — a single session firing 20 queries
    // would not exercise the concurrency this invariant is actually for.
    const clients = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const c = new Client({ connectionString: container.getConnectionUri() });
        await c.connect();
        return c;
      }),
    );

    try {
      const results = await Promise.allSettled(
        workspaceIds.map((workspaceId, i) => addMember(clients[i]!, workspaceId, owner, "owner")),
      );

      const succeeded = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(19);
      for (const failure of failed) {
        expect((failure as PromiseRejectedResult).reason.message).toMatch(/duplicate key/i);
      }

      const ownedCount = await client.query(
        "SELECT count(*) FROM workspace_members WHERE user_id = $1 AND role = 'owner' AND status = 'active'",
        [owner],
      );
      expect(Number(ownedCount.rows[0].count)).toBe(1);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  // ---- scenario 4 ------------------------------------------------------

  it("scenario 4 — removing a member then re-adding them is permitted", async () => {
    const workspaceId = await createWorkspace();
    const user = await createUser();

    await addMember(client, workspaceId, user, "analyst");
    await client.query(
      "UPDATE workspace_members SET status = 'removed' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, user],
    );

    await expect(addMember(client, workspaceId, user, "analyst")).resolves.toBeDefined();

    const rows = await client.query(
      "SELECT status FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 ORDER BY created_at",
      [workspaceId, user],
    );
    expect(rows.rows.map((r) => r.status)).toEqual(["removed", "active"]);
  });

  // ---- scenario 5 ------------------------------------------------------

  it("scenario 5 — a support grant where approver equals requester is rejected by the check", async () => {
    const workspaceId = await createWorkspace();
    const person = await createUser();
    const otherPerson = await createUser();

    await expect(
      client.query(
        `INSERT INTO support_grants
           (workspace_id, requested_by, approved_by, scope, justification, ticket_ref, expires_at)
         VALUES ($1, $2, $2, 'metadata', 'debugging', 'TICKET-1', now() + interval '1 day')`,
        [workspaceId, person],
      ),
    ).rejects.toThrow(/ck_support_dual_control/i);

    await expect(
      client.query(
        `INSERT INTO support_grants
           (workspace_id, requested_by, approved_by, scope, justification, ticket_ref, expires_at)
         VALUES ($1, $2, $3, 'metadata', 'debugging', 'TICKET-1', now() + interval '1 day')`,
        [workspaceId, person, otherPerson],
      ),
    ).resolves.toBeDefined();
  });

  // ---- scenario 6 ------------------------------------------------------

  it("scenario 6 — driving a wallet balance negative is rejected", async () => {
    const workspaceId = await createWorkspace();
    await createWallet(client, workspaceId, { included: 5 });

    await expect(
      client.query("UPDATE credit_wallets SET included_balance = -1 WHERE workspace_id = $1", [workspaceId]),
    ).rejects.toThrow(/ck_wallet_nonneg/i);
  });

  // ---- scenario 7 ------------------------------------------------------

  it("scenario 7 — setting reserved above the total balance is rejected", async () => {
    const workspaceId = await createWorkspace();
    await createWallet(client, workspaceId, { included: 10, purchased: 0, reserved: 0 });

    await expect(
      client.query("UPDATE credit_wallets SET reserved = 11 WHERE workspace_id = $1", [workspaceId]),
    ).rejects.toThrow(/ck_wallet_reserved/i);

    // Boundary: reserved exactly equal to the total is permitted.
    await expect(
      client.query("UPDATE credit_wallets SET reserved = 10 WHERE workspace_id = $1", [workspaceId]),
    ).resolves.toBeDefined();
  });

  // ---- scenario 8 ------------------------------------------------------

  it("scenario 8 — enabling auto-top-up above the bound is rejected", async () => {
    const workspaceId = await createWorkspace();

    await expect(
      createWallet(client, workspaceId, {
        autoTopupEnabled: true,
        autoTopupPackKey: "pack_small",
        autoTopupThreshold: 100,
        autoTopupMaxPerCycle: 21,
      }),
    ).rejects.toThrow(/ck_autotopup_bounded/i);

    // Boundary: the documented max (20) is permitted.
    await expect(
      createWallet(client, workspaceId, {
        autoTopupEnabled: true,
        autoTopupPackKey: "pack_small",
        autoTopupThreshold: 100,
        autoTopupMaxPerCycle: 20,
      }),
    ).resolves.toBeDefined();
  });

  it("enabling auto-top-up with no pack key is rejected regardless of the other fields", async () => {
    const workspaceId = await createWorkspace();
    await expect(
      createWallet(client, workspaceId, {
        autoTopupEnabled: true,
        autoTopupPackKey: null,
        autoTopupThreshold: 100,
        autoTopupMaxPerCycle: 5,
      }),
    ).rejects.toThrow(/ck_autotopup_bounded/i);
  });

  // ---- scenario 9 ------------------------------------------------------

  it("scenario 9 — updating or deleting a ledger row is rejected by the trigger", async () => {
    const workspaceId = await createWorkspace();
    const inserted = await insertLedgerEntry(client, workspaceId);
    const id = inserted.rows[0].id;

    await expect(client.query("UPDATE credit_ledger SET credits = 999 WHERE id = $1", [id])).rejects.toThrow(
      /append-only/i,
    );
    await expect(client.query("DELETE FROM credit_ledger WHERE id = $1", [id])).rejects.toThrow(/append-only/i);

    const stillThere = await client.query("SELECT credits FROM credit_ledger WHERE id = $1", [id]);
    expect(stillThere.rows[0].credits).toBe(10);
  });

  // ---- scenario 10 -----------------------------------------------------

  it("scenario 10 — a second ledger row with the same workspace, type, and idempotency key is rejected", async () => {
    const workspaceId = await createWorkspace();
    await insertLedgerEntry(client, workspaceId, { entryType: "reserve", idempotencyKey: "run-42" });

    await expect(
      insertLedgerEntry(client, workspaceId, { entryType: "reserve", idempotencyKey: "run-42" }),
    ).rejects.toThrow(/duplicate key/i);

    // A different entry_type with the same key is a different row — the
    // uniqueness is over the (workspace, entry_type, key) triple, not the key alone.
    await expect(
      insertLedgerEntry(client, workspaceId, { entryType: "commit", idempotencyKey: "run-42" }),
    ).resolves.toBeDefined();
  });

  // ---- bonus: credit_daily_counters non-negative check ------------------

  it("credit_daily_counters rejects a negative used_count", async () => {
    const workspaceId = await createWorkspace();
    await expect(
      client.query(
        "INSERT INTO credit_daily_counters (workspace_id, utc_date, action_code, used_count, limit_count) VALUES ($1, CURRENT_DATE, 'lookup', -1, 3)",
        [workspaceId],
      ),
    ).rejects.toThrow(/ck_daily_nonneg/i);
  });

  // ---- "one active row" partial unique indexes ---------------------------
  // QA coverage audit: these six follow the identical "partial unique index
  // makes an invalid state unrepresentable" pattern the 11 numbered scenarios
  // test for ownership, but had no coverage at all. ux_workspace_keys_active
  // in particular is its own named acceptance-criteria line, not just an
  // 11-scenario-table item.

  it("ux_workspace_keys_active — one active DEK per workspace, but any number retired", async () => {
    const workspaceId = await createWorkspace();
    const insertKey = (status: string) =>
      client.query(
        "INSERT INTO workspace_keys (workspace_id, dek_id, wrapped_dek, kms_key_arn, status) VALUES ($1, $2, 'x', 'arn:aws:kms:x', $3)",
        [workspaceId, `dek-${Math.random().toString(36).slice(2)}`, status],
      );

    await expect(insertKey("active")).resolves.toBeDefined();
    await expect(insertKey("active")).rejects.toThrow(/duplicate key/i);
    await expect(insertKey("retired")).resolves.toBeDefined();
    await expect(insertKey("retired")).resolves.toBeDefined();
  });

  it("ux_subscriptions_active — one subscription per workspace among trialing/active/past_due", async () => {
    const workspaceId = await createWorkspace();
    const insertSub = (status: string) =>
      client.query(
        `INSERT INTO subscriptions
           (workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id,
            status, current_period_start, current_period_end)
         VALUES ($1, 'starter', 'monthly', 'cus_x', $2, $3, now(), now() + interval '30 days')`,
        [workspaceId, `sub_${Math.random().toString(36).slice(2)}`, status],
      );

    await expect(insertSub("trialing")).resolves.toBeDefined();
    await expect(insertSub("active")).rejects.toThrow(/duplicate key/i);
    await expect(insertSub("canceled")).resolves.toBeDefined();
  });

  it("ux_addons_active — one active add-on per workspace and kind, but a deactivated one frees the slot", async () => {
    const workspaceId = await createWorkspace();
    const subResult = await client.query<{ id: string }>(
      `INSERT INTO subscriptions
         (workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id,
          status, current_period_start, current_period_end)
       VALUES ($1, 'growth', 'monthly', 'cus_x', 'sub_x', 'active', now(), now() + interval '30 days')
       RETURNING id`,
      [workspaceId],
    );
    const subscriptionId = subResult.rows[0]!.id;
    const insertAddon = (kind: string, activeUntil: string | null) =>
      client.query(
        `INSERT INTO subscription_addons
           (workspace_id, subscription_id, kind, quantity, unit_price_usd, stripe_subscription_item_id, active_until)
         VALUES ($1, $2, $3, 1, 10, $4, $5)`,
        [workspaceId, subscriptionId, kind, `si_${Math.random().toString(36).slice(2)}`, activeUntil],
      );

    await expect(insertAddon("extra_seat", null)).resolves.toBeDefined();
    await expect(insertAddon("extra_seat", null)).rejects.toThrow(/duplicate key/i);
    await expect(insertAddon("extra_project", null)).resolves.toBeDefined();

    await client.query(
      "UPDATE subscription_addons SET active_until = now() WHERE workspace_id = $1 AND kind = 'extra_seat'",
      [workspaceId],
    );
    await expect(insertAddon("extra_seat", null)).resolves.toBeDefined();
  });

  it("ux_sso_workspace — one non-disabled SSO config per workspace, but any number disabled", async () => {
    const workspaceId = await createWorkspace();
    const insertSso = (status: string) =>
      client.query(
        `INSERT INTO sso_configurations
           (workspace_id, protocol, idp_entity_id, idp_sso_url, idp_certificate, email_domains, status)
         VALUES ($1, 'oidc', 'entity', 'https://idp.example/sso', 'cert', ARRAY['example.com']::citext[], $2)`,
        [workspaceId, status],
      );

    await expect(insertSso("pending")).resolves.toBeDefined();
    await expect(insertSso("active")).rejects.toThrow(/duplicate key/i);
    await expect(insertSso("disabled")).resolves.toBeDefined();
    await expect(insertSso("disabled")).resolves.toBeDefined();
  });

  it("ux_invitations_pending — one pending invite per workspace and email, but revoking frees it", async () => {
    const workspaceId = await createWorkspace();
    const inviter = await createUser();
    const email = "invitee@example.com";
    // A fresh token per call — ux_invitations_token (a different, unrelated
    // unique index: no two invitations anywhere ever share a token) must not
    // fire before ux_invitations_pending gets a chance to.
    const insertInvite = () =>
      client.query(
        `INSERT INTO workspace_invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, 'analyst', $3, $4, now() + interval '7 days')`,
        [workspaceId, email, Buffer.from(Math.random().toString(36).slice(2)), inviter],
      );

    await expect(insertInvite()).resolves.toBeDefined();
    await expect(insertInvite()).rejects.toThrow(/duplicate key/i);

    await client.query(
      "UPDATE workspace_invitations SET revoked_at = now() WHERE workspace_id = $1 AND email = $2",
      [workspaceId, email],
    );
    await expect(insertInvite()).resolves.toBeDefined();
  });

  it("ux_credit_purchases_pi — dedupes a Stripe payment intent, but multiple NULLs are fine", async () => {
    const workspaceId = await createWorkspace();
    await client.query("INSERT INTO credit_packs (key, display_name, credits, price_usd) VALUES ('pack_a', 'Pack A', 100, 10)");
    const insertPurchase = (paymentIntentId: string | null) =>
      client.query(
        "INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd, stripe_payment_intent_id) VALUES ($1, 'pack_a', 100, 10, $2)",
        [workspaceId, paymentIntentId],
      );

    await expect(insertPurchase("pi_123")).resolves.toBeDefined();
    await expect(insertPurchase("pi_123")).rejects.toThrow(/duplicate key/i);
    await expect(insertPurchase(null)).resolves.toBeDefined();
    await expect(insertPurchase(null)).resolves.toBeDefined();
  });

  // ---- high-churn table tuning (its own acceptance-criteria line) -------

  it("credit_wallets and usage_counters carry the reduced fillfactor and aggressive vacuum threshold", async () => {
    const result = await client.query<{ relname: string; reloptions: string[] }>(
      "SELECT relname, reloptions FROM pg_class WHERE relname IN ('credit_wallets', 'usage_counters')",
    );
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      // data-model.md §8: 0.02 / 0.01 exactly, for these two tables by name —
      // not a rounder-looking neighbour. A prior draft of this test asserted
      // 0.05/0.05, which would have locked in the migration's original bug
      // instead of catching it.
      expect(row.reloptions, row.relname).toEqual(
        expect.arrayContaining([
          "fillfactor=70",
          "autovacuum_vacuum_scale_factor=0.02",
          "autovacuum_analyze_scale_factor=0.01",
        ]),
      );
    }
  });

  // ---- plan-entitlements seed matches its TS source of truth, in the DB ---
  // QA coverage audit: the unit suite validates PLAN_ENTITLEMENTS (the TS
  // object) against the zod schema, but nothing previously checked that the
  // hand-pasted JSON literals actually shipped in the migration are what
  // scripts/print-entitlements.mts would produce today. This closes that gap
  // by reading the seed back out of a real database and comparing it.

  it("every seeded plan's entitlements column matches PLAN_ENTITLEMENTS exactly, and validates against the schema", async () => {
    const { PLAN_ENTITLEMENTS } = await import("../../src/db/seed/plan-entitlements.js");
    const { planEntitlementsSchema } = await import("../../contracts/entitlements/plan-entitlements.schema.js");

    const result = await client.query<{ key: string; entitlements: unknown }>(
      "SELECT key, entitlements FROM plans ORDER BY sort_order",
    );
    expect(result.rows).toHaveLength(5);

    for (const row of result.rows) {
      const parsed = planEntitlementsSchema.safeParse(row.entitlements);
      expect(parsed.success, `${row.key} entitlements failed schema validation from the live DB`).toBe(true);
      expect(row.entitlements, row.key).toEqual(PLAN_ENTITLEMENTS[row.key as keyof typeof PLAN_ENTITLEMENTS]);
    }
  });

  // ---- credit_ledger / usage_ledger's FK to workspaces -------------------
  // Code review: workspace_id REFERENCES workspaces(id) ON DELETE CASCADE was
  // added to both tables (billing-and-credits.md's DDL snippet had omitted
  // it, unlike every sibling table in the file) on the strength of prose
  // describing this exact behaviour.
  //
  // A first version of this test tried to prove the cascade by actually
  // deleting a workspace and checking the ledger rows vanished — and caught a
  // real, unresolved design conflict: Postgres fires a table's own row
  // triggers for cascade-originated deletes too, so credit_ledger's
  // append-only guard (app.reject_mutation(), BEFORE DELETE) rejects the
  // cascade just as it would a direct DELETE. As it stands today, a
  // workspace with any credit_ledger history cannot be hard-deleted at all.
  // That is a real gap, but it is not this story's to close: workspace
  // hard-delete is an orchestrated, not-yet-built sequence (per
  // billing-and-credits.md's own "exported before the cascade runs, never
  // after" and the NFR-CMP-08 purge-journal machinery), and whichever story
  // builds it will need to explicitly bypass the append-only guard for that
  // one controlled operation. Until then, failing closed — refusing to
  // delete a workspace with billing history rather than silently succeeding
  // or silently orphaning rows — is the safe default, not a bug. This test
  // verifies the FK itself is configured correctly, and separately locks in
  // today's real, safe behaviour instead of asserting a cascade that cannot
  // currently complete.

  it("credit_ledger and usage_ledger have an ON DELETE CASCADE foreign key to workspaces", async () => {
    const result = await client.query<{ table_name: string; confdeltype: string }>(
      `SELECT conrelid::regclass::text AS table_name, confdeltype
       FROM pg_constraint
       WHERE conrelid IN ('credit_ledger'::regclass, 'usage_ledger'::regclass)
         AND confrelid = 'workspaces'::regclass`,
    );
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.confdeltype, row.table_name).toBe("c"); // 'c' = ON DELETE CASCADE
    }
  });

  it("today: deleting a workspace with ledger history fails closed rather than silently succeeding", async () => {
    const workspaceId = await createWorkspace();
    await insertLedgerEntry(client, workspaceId);

    await expect(client.query("DELETE FROM workspaces WHERE id = $1", [workspaceId])).rejects.toThrow(
      /append-only/i,
    );

    const workspaceStillThere = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
    expect(workspaceStillThere.rowCount).toBe(1);
  });

  // ---- scenario 11 -----------------------------------------------------

  it("scenario 11 — rolling the migration back is clean", async () => {
    const rolledBack = await rollbackLast(client);
    expect(rolledBack).toBe("0002_identity_tenancy_billing");

    const result = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
    );
    expect(result.rows).toHaveLength(0);

    const fnGone = await client.query(
      "SELECT 1 FROM pg_proc WHERE proname = 'reject_mutation' AND pronamespace = 'app'::regnamespace",
    );
    expect(fnGone.rowCount).toBe(0);

    // 0001's app schema and its own functions are untouched by 0002's rollback.
    const appSchemaStillThere = await client.query(
      "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'app'",
    );
    expect(appSchemaStillThere.rowCount).toBe(1);
  });
});
