import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// STORY-072 migration 0022 — the two guarantees the second-engineer review
// found were documented rather than enforced.
//
// Neither is in the runtime path, and both are exactly the kind of thing that
// goes unnoticed for a year and then lands on whoever builds STORY-076.

describe("STORY-072 · credit_ledger.attempt", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE credit_ledger, workspaces CASCADE");
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
  });

  async function entry(entryType: string, key: string, attempt: number): Promise<void> {
    await db.query(
      `INSERT INTO credit_ledger
         (workspace_id, actor_type, entry_type, credits, included_after, purchased_after, reserved_after,
          idempotency_key, attempt)
       VALUES ($1,'system',$2,100,0,0,0,$3,$4)`,
      [workspaceId, entryType, key, attempt],
    );
  }

  it("a reservation MAY have several attempts under one request key", async () => {
    await entry("reserve", "job", 1);
    await entry("reserve", "job", 2);
    const rows = await db.query("SELECT 1 FROM credit_ledger WHERE entry_type = 'reserve'");
    expect(rows.rowCount).toBe(2);
  });

  it("⚠ a PURCHASE may not — the widened index must not weaken uniqueness for entry types with no retries", async () => {
    // Reproduced by the review: widening `ux_credit_ledger_idem` to include
    // `attempt` made two `purchase` rows under one Stripe idempotency key
    // representable, which is a duplicate credit grant. The old index made
    // that impossible, and a comment saying "those types always use attempt
    // 1" is a convention, not a guarantee — `appendLedgerEntry` takes the
    // attempt as a parameter, so any future caller can vary it.
    await entry("purchase", "stripe-evt-1", 1);
    await expect(entry("purchase", "stripe-evt-1", 2)).rejects.toMatchObject({
      constraint: "ck_credit_ledger_attempt_scope",
    });
  });

  it("holds the same line for grant, refund, expire and adjustment", async () => {
    for (const entryType of ["grant", "refund", "expire", "adjustment"]) {
      await expect(entry(entryType, `k-${entryType}`, 2)).rejects.toMatchObject({
        constraint: "ck_credit_ledger_attempt_scope",
      });
    }
  });

  it("still refuses a duplicate (workspace, type, key, attempt)", async () => {
    await entry("reserve", "job", 1);
    await expect(entry("reserve", "job", 1)).rejects.toMatchObject({ constraint: "ux_credit_ledger_idem" });
  });

  it("refuses an attempt below 1", async () => {
    await expect(entry("reserve", "job", 0)).rejects.toMatchObject({ constraint: "ck_credit_ledger_attempt" });
  });
});

describe("STORY-072 · rolling 0022 back", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  it("rolls back cleanly when no request key has more than one attempt", async () => {
    const rolled = await rollbackLast(db);
    expect(rolled).toBe("0022_credit_ledger_attempt");

    const column = await db.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'credit_ledger' AND column_name = 'attempt'",
    );
    expect(column.rowCount).toBe(0);
    await migrateUp(db);
  });

  it("⚠ REFUSES OUT LOUD, naming the reconciliation, when a retried family exists", async () => {
    // The first version of this down migration tried a DELETE keeping the
    // earliest row per key. It could never execute: `credit_ledger` carries
    // a `reject_update_delete` trigger, so it failed with SQLSTATE 25006 and
    // named the trigger rather than the billing decision — succeeding only
    // when there was nothing to collapse, and failing exactly when its own
    // comment applied.
    //
    // Disabling the trigger would authorise a migration to rewrite a ledger
    // silently, which §6 rule 4 says the system must never do.
    const workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    for (const attempt of [1, 2]) {
      await db.query(
        `INSERT INTO credit_ledger
           (workspace_id, actor_type, entry_type, credits, included_after, purchased_after, reserved_after,
            idempotency_key, attempt)
         VALUES ($1,'system','reserve',100,0,0,0,'retried',$2)`,
        [workspaceId, attempt],
      );
    }

    await expect(rollbackLast(db)).rejects.toMatchObject({
      message: expect.stringMatching(/cannot roll back 0022: 1 request key\(s\)/) as unknown as string,
    });
    // And it says what a human has to do, rather than naming a trigger.
    await expect(rollbackLast(db)).rejects.toMatchObject({
      message: expect.stringContaining("adjustment") as unknown as string,
    });
  });
});
