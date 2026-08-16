import { inject } from "vitest";
import type { ThreeTenantFixture } from "./three-tenant-fixture.js";
import type { AssertionContext } from "./assertion-context.js";
import type { MaintenanceConnection } from "./broken-database.js";

// STORY-012 T2 — the single provide()/inject() contract between global-setup.ts
// (runs once, in a separate process, before every test file) and every spec
// file. Everything here must be JSON-serializable — no live pg.Client, no
// testcontainers handle — each spec file opens its OWN connections to the
// ONE shared container using this connection info.
export interface IsolationProvidedContext {
  readonly host: string;
  readonly port: number;
  readonly maintenanceDatabase: string;
  readonly seedDatabase: string;
  readonly breakerTemplateDatabase: string;
  readonly superuser: { readonly user: string; readonly password: string };
  readonly fixture: ThreeTenantFixture;
  readonly setupStartedAt: number;
  readonly target: "local" | "pooled" | "staging";
}

declare module "vitest" {
  export interface ProvidedContext {
    isolation: IsolationProvidedContext;
  }
}

export function getIsolationProvidedContext(): IsolationProvidedContext {
  return inject("isolation");
}

/** The AssertionContext every non-breaker spec runs against — the shared seed database. */
export function getAssertionContext(): AssertionContext {
  const provided = getIsolationProvidedContext();
  return {
    target: { host: provided.host, port: provided.port, database: provided.seedDatabase },
    superuser: provided.superuser,
    fixture: provided.fixture,
  };
}

export function getMaintenanceConnection(): MaintenanceConnection {
  const provided = getIsolationProvidedContext();
  return {
    host: provided.host,
    port: provided.port,
    maintenanceDatabase: provided.maintenanceDatabase,
    superuser: provided.superuser,
  };
}
