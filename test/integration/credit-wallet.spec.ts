import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import {
  commitCredits,
  purchasableOptions,
  readWallet,
  releaseCredits,
  reserveCredits,
} from "../../src/lib/credits/wallet.js";

// STORY-072 — one of the four dangerous areas. Every scenario here is a
// `WHERE` clause or a race, so none of them can be proven without a real
// database.

describe("STORY-072 · the credit wallet", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let connectionUri: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      // The story's concurrency test opens TWO HUNDRED connections at once,
      // and Postgres defaults to 100. Raising it here rather than thinning
      // the test: "two hundred concurrent debits" is the scenario, and a
      // pooled twenty would only ever put twenty statements in flight —
      // which is a different, weaker claim than the one that must pass
      // before merge.
      .withCommand(["postgres", "-c", "max_connections=400"])
      .start();
    connectionUri = container.getConnectionUri();
    db = new Client({ connectionString: connectionUri });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  async function setUp(
    wallet: { included?: number; purchased?: number; reserved?: number } = {},
    planKey = "growth",
  ): Promise<void> {
    await db.query("TRUNCATE credit_packs, credit_wallets, workspaces CASCADE");
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,$3)", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
      planKey,
    ]);
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, purchased_balance, reserved, cycle_start, cycle_end)
       VALUES ($1,$2,$3,$4, (now() AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date + 30)`,
      [workspaceId, wallet.included ?? 0, wallet.purchased ?? 0, wallet.reserved ?? 0],
    );
  }

  beforeEach(async () => {
    await setUp({ included: 100, purchased: 0 });
  });

  it("scenario 1 — a reservation within balance succeeds and reduces available", async () => {
    const outcome = await reserveCredits(db, workspaceId, 40);
    expect(outcome.ok).toBe(true);
    expect(outcome.wallet).toMatchObject({ reserved: 40, available: 60 });
  });

  it("scenario 2 — a reservation beyond balance reserves NOTHING", async () => {
    const outcome = await reserveCredits(db, workspaceId, 101);
    expect(outcome.ok).toBe(false);
    expect((await readWallet(db, workspaceId))!.reserved).toBe(0);
  });

  it("counts an existing reservation against a new one", async () => {
    await reserveCredits(db, workspaceId, 60);
    expect((await reserveCredits(db, workspaceId, 60)).ok).toBe(false);
    expect((await readWallet(db, workspaceId))!.reserved).toBe(60);
  });

  it("permits a reservation for EXACTLY the available balance", async () => {
    // The predicate is `>=`, and an off-by-one here would refuse a customer
    // the last action their balance pays for.
    expect((await reserveCredits(db, workspaceId, 100)).ok).toBe(true);
  });

  it("scenario 6 — the EXPIRING bucket is consumed first", async () => {
    // Spending durable purchased credits first would let granted credits
    // lapse at cycle end while the paid-for ones were consumed.
    await setUp({ included: 30, purchased: 70 });
    await reserveCredits(db, workspaceId, 50);
    const after = await commitCredits(db, workspaceId, 50, 50);

    expect(after).toMatchObject({ includedBalance: 0, purchasedBalance: 50, reserved: 0 });
  });

  it("leaves the purchased bucket untouched while included covers the spend", async () => {
    await setUp({ included: 100, purchased: 70 });
    await reserveCredits(db, workspaceId, 40);
    expect(await commitCredits(db, workspaceId, 40, 40)).toMatchObject({
      includedBalance: 60,
      purchasedBalance: 70,
    });
  });

  it("scenario 8 — a flat-priced action commits EXACTLY its reservation", async () => {
    await reserveCredits(db, workspaceId, 40);
    const after = await commitCredits(db, workspaceId, 40, 40);
    expect(after).toMatchObject({ includedBalance: 60, reserved: 0 });
  });

  it("scenario 7 — a per-unit action commits less and the difference is released", async () => {
    await reserveCredits(db, workspaceId, 40);
    const after = await commitCredits(db, workspaceId, 12, 40);
    // 12 spent, and the whole 40 came off `reserved` — not 12.
    expect(after).toMatchObject({ includedBalance: 88, reserved: 0 });
    expect(after!.available).toBe(88);
  });

  it("records what was actually spent in lifetime_spent, not what was reserved", async () => {
    await reserveCredits(db, workspaceId, 40);
    await commitCredits(db, workspaceId, 12, 40);
    const row = await db.query<{ lifetime_spent: string }>(
      "SELECT lifetime_spent::text FROM credit_wallets WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(Number(row.rows[0]!.lifetime_spent)).toBe(12);
  });

  it("refuses a commit larger than its reservation, in code rather than at the CHECK", async () => {
    await reserveCredits(db, workspaceId, 10);
    await expect(commitCredits(db, workspaceId, 40, 10)).rejects.toThrow(/cannot commit 40/);
  });

  it("a DOUBLE COMMIT changes nothing rather than driving reserved negative", async () => {
    await reserveCredits(db, workspaceId, 40);
    await commitCredits(db, workspaceId, 40, 40);

    expect(await commitCredits(db, workspaceId, 40, 40)).toBeNull();
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 60, reserved: 0 });
  });

  it("scenario 9 — releasing twice never drives reserved below zero", async () => {
    await reserveCredits(db, workspaceId, 40);
    await releaseCredits(db, workspaceId, 40);
    await releaseCredits(db, workspaceId, 40);
    expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 0, includedBalance: 100 });
  });

  it("a release restores the balance to spendable", async () => {
    await reserveCredits(db, workspaceId, 100);
    expect((await reserveCredits(db, workspaceId, 1)).ok).toBe(false);
    await releaseCredits(db, workspaceId, 100);
    expect((await reserveCredits(db, workspaceId, 100)).ok).toBe(true);
  });

  // ── The schema as a second layer ────────────────────────────────────────

  it("scenario 4 — a negative balance is REJECTED BY THE SCHEMA", async () => {
    // Stronger than making it unreachable: this holds even if a future code
    // path forgets the protocol entirely.
    await expect(
      db.query("UPDATE credit_wallets SET included_balance = -1 WHERE workspace_id = $1", [workspaceId]),
    ).rejects.toMatchObject({ constraint: "ck_wallet_nonneg" });
  });

  it("scenario 4 — a negative reservation is rejected by the schema", async () => {
    await expect(
      db.query("UPDATE credit_wallets SET reserved = -1 WHERE workspace_id = $1", [workspaceId]),
    ).rejects.toMatchObject({ constraint: "ck_wallet_nonneg" });
  });

  it("scenario 5 — reserving beyond the total is rejected by the schema", async () => {
    await expect(
      db.query("UPDATE credit_wallets SET reserved = 101 WHERE workspace_id = $1", [workspaceId]),
    ).rejects.toMatchObject({ constraint: "ck_wallet_reserved" });
  });

  // ── AC9's refusal payload ───────────────────────────────────────────────

  it("scenario 11 — purchasable options are filtered to the workspace's tier", async () => {
    await setUp({ included: 0 }, "starter");
    await db.query(
      `INSERT INTO credit_packs (key, display_name, credits, price_usd, min_plan_key, is_public, sort_order)
       VALUES ('small','Small pack',500,49,NULL,true,1),
              ('large','Large pack',5000,399,'growth',true,2),
              ('hidden','Internal',100,1,NULL,false,3)`,
    );

    const options = await purchasableOptions(db, workspaceId);
    // `large` needs Growth; this workspace is on Starter. Offering it would
    // send the customer to a purchase flow that refuses them for a second,
    // unrelated reason.
    expect(options.map((option) => option.key)).toEqual(["small"]);
  });

  it("offers a higher-tier pack once the workspace is on that tier", async () => {
    await setUp({ included: 0 }, "business");
    await db.query(
      `INSERT INTO credit_packs (key, display_name, credits, price_usd, min_plan_key, is_public, sort_order)
       VALUES ('small','Small pack',500,49,NULL,true,1),
              ('large','Large pack',5000,399,'growth',true,2)`,
    );
    expect((await purchasableOptions(db, workspaceId)).map((o) => o.key)).toEqual(["small", "large"]);
  });

  // ── AC13/AC14 — the grant, NOT TESTED HERE BECAUSE IT IS NOT BUILT ────
  //
  // `refreshIncludedGrant` was written, tested green, and then removed: the
  // second-engineer review showed its clamp was not §5's pro-rata rule and
  // that a same-cycle resync minted free credits. The two tests that lived
  // here passed against that behaviour, which is the problem with them —
  // they asserted what the code did rather than what §5 says.
  //
  // Grant refresh lands with the subscription lifecycle that knows the prior
  // grant and the cycle position (STORY-075). See wallet.ts.

  // ── Scenario 3 — the one that must pass before merge ────────────────────

  it("scenario 3 — TWO HUNDRED concurrent debits never commit more than the balance", async () => {
    // The realistic failure: two operators confirming the same expensive
    // action against a balance that covers one. The damage is a negative
    // balance nobody notices until reconciliation, so this is the test the
    // story says must pass before merge.
    const PRICE = 7;
    const BALANCE = 301; // 43 whole actions, and a remainder that pays for none.
    await setUp({ included: BALANCE });

    const clients = await Promise.all(
      Array.from({ length: 200 }, async () => {
        const client = new Client({ connectionString: connectionUri });
        await client.connect();
        return client;
      }),
    );

    try {
      // Each attempt reports THREE outcomes, not two: committed, cleanly
      // refused, or threw. Collapsing "refused" and "threw" into one boolean
      // is what hid the mutant.
      const outcomes = await Promise.all(
        clients.map(async (client): Promise<{ ok: boolean; error: unknown }> => {
          try {
            const reservation = await reserveCredits(client, workspaceId, PRICE);
            if (!reservation.ok) return { ok: false, error: null };
            await commitCredits(client, workspaceId, PRICE, PRICE);
            return { ok: true, error: null };
          } catch (error) {
            return { ok: false, error };
          }
        }),
      );

      const committed = outcomes.filter((outcome) => outcome.ok).length;
      const refused = outcomes.filter((outcome) => !outcome.ok && outcome.error === null).length;
      const threw = outcomes.filter((outcome) => outcome.error !== null);
      const wallet = (await readWallet(db, workspaceId))!;

      // ⚠ THE ASSERTION THAT DISCRIMINATES THE PREDICATE, and the one the
      // first version of this test was missing. The second-engineer review
      // deleted the sufficiency test from the reserve statement and every
      // assertion below still held — the losers blew up on
      // `ck_wallet_reserved` instead, and the test only went red because an
      // unhandled rejection escaped `Promise.all`. So it was proving the
      // schema CHECK, not AC1's "single conditional statement with the
      // sufficiency test in its predicate".
      //
      // A LOSER MUST GET A CLEAN `ok: false`, not an exception. That is what
      // "the loser gets zero rows and a clean refusal, with no compensating
      // action needed" means, and it is false the moment the predicate goes.
      expect(threw.map((outcome) => String(outcome.error))).toEqual([]);
      expect(refused).toBe(200 - committed);

      expect(committed * PRICE).toBeLessThanOrEqual(BALANCE);
      expect(committed).toBe(Math.floor(BALANCE / PRICE));
      expect(wallet.includedBalance).toBe(BALANCE - committed * PRICE);
      expect(wallet.reserved).toBe(0);
      expect(wallet.includedBalance).toBeGreaterThanOrEqual(0);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  }, 120_000);

  it("two hundred concurrent RESERVATIONS never oversubscribe, even with none committed", async () => {
    // The reservation alone must hold the line: `reserved` can never exceed
    // the total, and the schema's CHECK would have raised if it tried.
    const BALANCE = 50;
    await setUp({ included: BALANCE });

    const clients = await Promise.all(
      Array.from({ length: 200 }, async () => {
        const client = new Client({ connectionString: connectionUri });
        await client.connect();
        return client;
      }),
    );
    try {
      const outcomes = await Promise.all(
        clients.map(async (client) => {
          try {
            return await reserveCredits(client, workspaceId, 1);
          } catch (error) {
            return { ok: false, wallet: null, error };
          }
        }),
      );
      // Same discrimination as above: every loser refuses cleanly.
      expect(outcomes.filter((outcome) => "error" in outcome)).toEqual([]);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(BALANCE);
      expect((await readWallet(db, workspaceId))!.reserved).toBe(BALANCE);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  }, 120_000);
});
