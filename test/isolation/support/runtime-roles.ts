import { Client } from "pg";
import { resolvePassword } from "../../../src/db/dev-credentials.js";

// STORY-012 — CRITICAL, per this repo's own convention (see
// test/integration/generated-rls-and-tenant-context.spec.ts's header): every
// data-path assertion in this suite connects as the ACTUAL runtime role
// (nominara_app/nominara_worker/nominara_report/nominara_portal), never as
// the superuser. A superuser bypasses RLS by an entirely different mechanism
// than FORCE ROW LEVEL SECURITY addresses, so asserting against a superuser
// connection would pass vacuously regardless of whether any policy works.

export interface ConnectionTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
}

export async function connectAsRole(target: ConnectionTarget, role: string, password?: string): Promise<Client> {
  const client = new Client({
    host: target.host,
    port: target.port,
    database: target.database,
    user: role,
    // Default env (process.env), not an explicit {} override — so a real
    // NOMINARA_APP_DB_PASSWORD-style var (e.g. against staging) is honored
    // instead of always falling back to the local-development default.
    password: password ?? resolvePassword(role),
  });
  await client.connect();
  return client;
}
