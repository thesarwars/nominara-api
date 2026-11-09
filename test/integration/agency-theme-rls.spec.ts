import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { NotFoundError } from "../../src/api/errors/domain-errors.js";
import { AgencyService } from "../../src/modules/agency/agency.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-097 — brand_themes is tenant-scoped; the service carries no
// workspace_id predicate for correctness, so RLS is the whole guarantee.
// Connects as the real `nominara_app` role: the HTTP harness uses a
// superuser connection, which would pass this vacuously.
describe("STORY-097 · AgencyService under RLS, as nominara_app", () => {
  let container: StartedPostgreSqlContainer;
  let admin: Client;
  const service = new AgencyService({} as never);
  let appPool: Pool;

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
    admin = new Client({ connectionString: container.getConnectionUri() });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS app CASCADE");
    await admin.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await admin.query("DROP SCHEMA public CASCADE");
    await admin.query("CREATE SCHEMA public");
    await migrateUp(admin);
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      await admin.query(`ALTER ROLE ${role} PASSWORD ${admin.escapeLiteral(resolvePassword(role, {}))}`);
    }
    appPool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password: resolvePassword("nominara_app", {}) });
  });
  afterEach(async () => {
    await appPool.end();
    await admin.end();
  });

  async function workspace(plan: string): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1::uuid, $1::text, $1::text, $2)", [id, plan]);
    return id;
  }

  async function inTenant<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const app = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: resolvePassword("nominara_app", {}),
    });
    await app.connect();
    try {
      const context: TenantContext = { workspaceId, actorId: randomUUID() };
      return await withTenantContext(app, context, fn);
    } finally {
      await app.end();
    }
  }

  it("a theme in another workspace is invisible to list and 404 to update, and is left untouched", async () => {
    const a = await workspace("growth");
    const b = await workspace("growth");
    const theirs = await inTenant(b, () => service.saveTheme({ name: "Theirs" }));

    const mine = await inTenant(a, () => service.listThemes({ limit: 50 }));
    expect(mine.items.map((t) => t.theme_id)).not.toContain(theirs.theme_id);

    await expect(inTenant(a, () => service.saveTheme({ theme_id: theirs.theme_id, name: "Hijack" }))).rejects.toBeInstanceOf(NotFoundError);
    const stored = await admin.query("SELECT name FROM brand_themes WHERE id = $1", [theirs.theme_id]);
    expect((stored.rows[0] as { name: string }).name).toBe("Theirs");
  });

  it("each workspace has its own default; the first theme in each is the default", async () => {
    const a = await workspace("growth");
    const b = await workspace("growth");
    expect((await inTenant(a, () => service.saveTheme({ name: "A" }))).is_default).toBe(true);
    expect((await inTenant(b, () => service.saveTheme({ name: "B" }))).is_default).toBe(true);
  });

  it("brand removal is granted on a plan with whitelabel.remove_branding and refused without it", async () => {
    const growth = await workspace("growth");
    const business = await workspace("business");
    await expect(inTenant(growth, () => service.saveTheme({ hide_nominara_brand: true }))).rejects.toMatchObject({ code: "feature_not_in_plan" });
    expect((await inTenant(business, () => service.saveTheme({ hide_nominara_brand: true }))).hide_nominara_brand).toBe(true);
  });

  // Review round 1 (STORY-097, owner decision 67 n): the asset statements filter on `id = $1` only, so RLS is the only thing keeping workspaces apart.
  // recordAssetKey runs on its OWN pool connection outside the request transaction: this proves THAT transaction is confined to the caller's workspace.
  it("asset key reads and writes: a foreign theme is 404 on read and on record, and its key is left untouched", async () => {
    const a = await workspace("growth");
    const b = await workspace("growth");
    const theirs = await inTenant(b, () => service.saveTheme({ name: "Theirs" }));
    await admin.query("UPDATE brand_themes SET logo_light_key = 'dev/b/reports/branding/theirs.png' WHERE id = $1", [theirs.theme_id]);
    const recorder = new AgencyService(appPool);

    await expect(inTenant(a, () => service.assetKey(theirs.theme_id, "logo_light"))).rejects.toBeInstanceOf(NotFoundError);
    await expect(recorder.recordAssetKey({ workspaceId: a, actorId: randomUUID() }, theirs.theme_id, "logo_light", "dev/a/reports/branding/evil.png")).rejects.toBeInstanceOf(NotFoundError);
    const stored = await admin.query("SELECT logo_light_key FROM brand_themes WHERE id = $1", [theirs.theme_id]);
    expect((stored.rows[0] as { logo_light_key: string }).logo_light_key).toBe("dev/b/reports/branding/theirs.png");

    // The same call from the owning workspace works, and hands back the previous key.
    await expect(recorder.recordAssetKey({ workspaceId: b, actorId: randomUUID() }, theirs.theme_id, "logo_light", "dev/b/reports/branding/new.png")).resolves.toBe("dev/b/reports/branding/theirs.png");
  });
});
