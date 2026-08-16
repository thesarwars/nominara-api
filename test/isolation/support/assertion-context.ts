import { Client } from "pg";
import type { ThreeTenantFixture } from "./three-tenant-fixture.js";
import type { ConnectionTarget } from "./runtime-roles.js";

// STORY-012 — the shape every assertion function (test/isolation/assertions/
// iso-*.ts) receives. Deliberately plain data (host/port/database strings,
// fixture ids) rather than a live pool/session, so the EXACT same context
// shape works whether the assertion is invoked against the shared seeded
// database (green path) or a disposable per-breaker database copy (red path)
// — only `target.database` (and sometimes `superuser`) differs between them.

export interface SuperuserCredentials {
  readonly user: string;
  readonly password: string;
}

export interface AssertionContext {
  readonly target: ConnectionTarget;
  readonly superuser: SuperuserCredentials;
  readonly fixture: ThreeTenantFixture;
}

/** A fresh superuser connection to ctx.target — used only for catalog inspection/fixture seeding, never as the security boundary under test. */
export async function connectSuperuser(ctx: AssertionContext): Promise<Client> {
  const client = new Client({ ...ctx.target, user: ctx.superuser.user, password: ctx.superuser.password });
  await client.connect();
  return client;
}
