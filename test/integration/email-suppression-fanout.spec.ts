import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { hashEmailKey, normalizeEmail } from "../../src/lib/auth/email-otp.js";
import { SuppressionFanoutBlindError, poolTenantWrite, runSuppressionFanout, type TenantWrite } from "../../src/lib/email/suppression-fanout.js";

// STORY-178 AC4 / owner decision 9 — telling the workspaces. The webhook cannot see across tenants, so it leaves each
// suppression with `fanned_out_at` NULL; the report worker's sweep (an owner connection that sees every tenant) finds the
// scheduled reports whose recipients include the hashed address and writes ONE in-app notification per report, each inside
// that workspace's own tenant transaction. The address is in no notification and no log line.

const PEPPER = "fanout-test-pepper-000000000000000";
const ADDRESS = "Bounced.Person@Example.org";
const hashOf = (address: string): Buffer => hashEmailKey(normalizeEmail(address), PEPPER);

describe("STORY-178 · suppression fan-out", () => {
  let container: StartedPostgreSqlContainer;
  let owner: Client;
  let appPool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    owner = new Client({ connectionString: container.getConnectionUri() });
    await owner.connect();
    await migrateUp(owner);
    const password = resolvePassword("nominara_app", {});
    await owner.query(`ALTER ROLE nominara_app PASSWORD ${owner.escapeLiteral(password)}`);
    appPool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password, max: 4 });
  }, 300_000);
  afterAll(async () => {
    await appPool.end();
    await owner.end();
    await container.stop();
  });
  beforeEach(async () => {
    await owner.query("TRUNCATE email_suppressions, notifications, notification_emails, scheduled_reports, workspaces CASCADE");
  });

  const workspace = async (): Promise<string> => {
    const id = randomUUID();
    await owner.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1,'Secret Workspace Name',$2,'growth')", [id, `w-${id.slice(0, 8)}`]);
    return id;
  };
  const report = async (workspaceId: string, name: string, recipients: string[], active = true): Promise<string> => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO scheduled_reports (id, workspace_id, name, project_ids, cadence, recipients, active) VALUES ($1,$2,$3,ARRAY[gen_random_uuid()],'weekly',$4::citext[],$5)`,
      [id, workspaceId, name, recipients, active],
    );
    return id;
  };
  const suppress = async (address: string, kind: "bounce" | "complaint" = "bounce"): Promise<string> => {
    const id = randomUUID();
    await owner.query("INSERT INTO email_suppressions (id, recipient_hash, kind, provider_event_id) VALUES ($1,$2,$3,$4)", [id, hashOf(address), kind, `evt_${id}`]);
    return id;
  };
  // The production writer itself (poolTenantWrite), over the nominara_app pool.
  const tenantWrite: TenantWrite = (workspaceId, fn) => poolTenantWrite(appPool)(workspaceId, fn);
  const run = (write: TenantWrite = tenantWrite) => runSuppressionFanout(owner, write, PEPPER);
  const notes = async (workspaceId: string) =>
    (await owner.query<{ kind: string; severity: string; title: string; body: string; payload: Record<string, unknown>; workspace_id: string }>(
      "SELECT kind, severity, title, body, payload, workspace_id FROM notifications WHERE workspace_id = $1 ORDER BY created_at", [workspaceId])).rows;
  const fannedOut = async (id: string) => (await owner.query<{ fanned_out_at: Date | null }>("SELECT fanned_out_at FROM email_suppressions WHERE id = $1", [id])).rows[0]!.fanned_out_at;

  it("a hard bounce notifies EVERY workspace with an active report naming the address, one notification per report, in that workspace only", async () => {
    const [a, b, c] = [await workspace(), await workspace(), await workspace()];
    const ra = await report(a, "Acme monthly", ["client@example.org", "bounced.person@example.org"]);
    const rb1 = await report(b, "Beta weekly", ["BOUNCED.PERSON@EXAMPLE.ORG"]);
    const rb2 = await report(b, "Beta quarterly", ["x@example.org", ADDRESS]);
    await report(c, "Gamma", ["someone.else@example.org"]);
    const id = await suppress(ADDRESS);

    const result = await run();
    expect(result).toMatchObject({ claimed: 1, notified: 3, failed: 0 });

    const noteA = await notes(a);
    expect(noteA).toHaveLength(1);
    expect(noteA[0]).toMatchObject({ kind: "report.recipient_suppressed", severity: "warning", workspace_id: a });
    expect(noteA[0]!.body).toContain("Acme monthly");
    expect(noteA[0]!.payload).toMatchObject({ scheduled_report_id: ra, suppression_kind: "bounce" });
    expect((await notes(b)).map((n) => n.payload.scheduled_report_id).sort()).toEqual([rb1, rb2].sort());
    expect(await notes(c)).toEqual([]);
    expect(await fannedOut(id)).not.toBeNull();
  });

  it("names the report and the kind, and carries NO address, no workspace name and no hash", async () => {
    const a = await workspace();
    await report(a, "Acme monthly", [ADDRESS]);
    await suppress(ADDRESS, "complaint");
    await run();
    const text = JSON.stringify(await notes(a)).toLowerCase();
    expect(text).not.toContain("bounced.person");
    expect(text).not.toContain("example.org");
    expect(text).not.toContain("secret workspace name");
    expect(text).not.toContain(hashOf(ADDRESS).toString("hex"));
    expect(text).toContain("marked a report as spam");
  });

  it("a PAUSED report is not told about, and a suppression nobody's report includes is still marked done (nothing to do is done)", async () => {
    const a = await workspace();
    await report(a, "Paused", [ADDRESS], false);
    const id = await suppress(ADDRESS);
    expect(await run()).toMatchObject({ claimed: 1, notified: 0, failed: 0 });
    expect(await notes(a)).toEqual([]);
    expect(await fannedOut(id)).not.toBeNull();
  });

  it("is idempotent: a second pass finds nothing to claim and writes nothing", async () => {
    const a = await workspace();
    await report(a, "Acme", [ADDRESS]);
    await suppress(ADDRESS);
    await run();
    expect(await run()).toMatchObject({ claimed: 0, notified: 0, failed: 0 });
    expect(await notes(a)).toHaveLength(1);
  });

  it("a LIFTED suppression is never fanned out", async () => {
    const a = await workspace();
    await report(a, "Acme", [ADDRESS]);
    const id = await suppress(ADDRESS);
    await owner.query("UPDATE email_suppressions SET deleted_at = now() WHERE id = $1", [id]);
    expect(await run()).toMatchObject({ claimed: 0 });
    expect(await notes(a)).toEqual([]);
  });

  it("a workspace whose write FAILS leaves the suppression unfanned and is retried; the workspace that succeeded is not notified twice", async () => {
    const [a, b] = [await workspace(), await workspace()];
    await report(a, "Acme", [ADDRESS]);
    await report(b, "Beta", [ADDRESS]);
    const id = await suppress(ADDRESS);
    const flaky: TenantWrite = async (workspaceId, fn) => {
      if (workspaceId === b) throw new Error("connection lost");
      await tenantWrite(workspaceId, fn);
    };
    expect(await run(flaky)).toMatchObject({ claimed: 1, notified: 1, failed: 1 });
    expect(await fannedOut(id)).toBeNull();
    expect(await run()).toMatchObject({ claimed: 1, failed: 0 });
    expect(await notes(a)).toHaveLength(1);
    expect(await notes(b)).toHaveLength(1);
    expect(await fannedOut(id)).not.toBeNull();
  });

  it("each notification is written inside the OWNING workspace's tenant context, as nominara_app under RLS (never from the owner connection)", async () => {
    const [a, b] = [await workspace(), await workspace()];
    await report(a, "Acme", [ADDRESS]);
    await report(b, "Beta", [ADDRESS]);
    await suppress(ADDRESS);
    const seen: string[] = [];
    const spy: TenantWrite = async (workspaceId, fn) => {
      seen.push(workspaceId);
      await tenantWrite(workspaceId, fn);
    };
    await run(spy);
    expect(seen.sort()).toEqual([a, b].sort());
    for (const ws of [a, b]) for (const n of await notes(ws)) expect(n.workspace_id).toBe(ws);
  });

  it("REFUSES to run as a role that cannot see across tenants: it would find no report and look healthy", async () => {
    await suppress(ADDRESS);
    const client = await appPool.connect();
    try {
      await expect(runSuppressionFanout(client, tenantWrite, PEPPER)).rejects.toBeInstanceOf(SuppressionFanoutBlindError);
    } finally {
      client.release();
    }
  });

  it("a batch is bounded: the rest waits for the next pass, oldest first", async () => {
    const a = await workspace();
    await report(a, "Acme", ["one@example.org", "two@example.org", "three@example.org"]);
    for (const address of ["one@example.org", "two@example.org", "three@example.org"]) await suppress(address);
    expect(await runSuppressionFanout(owner, tenantWrite, PEPPER, 2)).toMatchObject({ claimed: 2, notified: 2 });
    expect(await runSuppressionFanout(owner, tenantWrite, PEPPER, 2)).toMatchObject({ claimed: 1, notified: 1 });
    expect(await notes(a)).toHaveLength(3);
  });

  it("LEAST PRIVILEGE: the owner connection reads workspace ids only, never a report's name or recipients; those are read in the workspace's own transaction", async () => {
    const a = await workspace();
    await report(a, "Acme monthly", [ADDRESS]);
    await suppress(ADDRESS);
    const ownerSql: string[] = [];
    const recording = new Proxy(owner, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: unknown, ...rest: unknown[]) => {
            ownerSql.push(typeof sql === "string" ? sql : JSON.stringify(sql));
            return (target.query as (...a: unknown[]) => unknown)(sql, ...rest);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const tenantSql: string[] = [];
    const spy: TenantWrite = (workspaceId, fn) =>
      tenantWrite(workspaceId, (tx) =>
        fn(
          new Proxy(tx, {
            get(target, prop, receiver) {
              if (prop === "query") {
                return (sql: unknown, ...rest: unknown[]) => {
                  tenantSql.push(typeof sql === "string" ? sql : JSON.stringify(sql));
                  return (target.query as (...a: unknown[]) => unknown)(sql, ...rest);
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          }),
        ),
      );
    expect(await runSuppressionFanout(recording, spy, PEPPER)).toMatchObject({ claimed: 1, notified: 1, failed: 0 });
    expect(ownerSql.filter((q) => /scheduled_reports/i.test(q)).every((q) => !/recipients|\bname\b/i.test(q))).toBe(true);
    expect(tenantSql.some((q) => /scheduled_reports/i.test(q) && /recipients/i.test(q))).toBe(true);
    expect((await notes(a))[0]!.body).toContain("Acme monthly");
  });
});
