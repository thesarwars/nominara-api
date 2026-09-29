// STORY-169 — shared "is this connection string local" guard, extracted from
// `src/db/studio.ts` so a second tool (the dev-only demo seed) can reuse the
// exact same allow-list rather than retyping it and risking the two drifting
// apart. Studio's own behaviour and error message are UNCHANGED — it still
// exports `assertLocalTarget`/`NonLocalStudioTargetError` itself, now built
// on top of the pieces here — so `test/unit/studio-target.spec.ts` needed no
// edit.
//
// This module makes no NODE_ENV or opt-in decision of its own. It only
// answers "is this host one of a developer's own machine, and nothing else",
// which is one of several independent checks a caller composes — see
// `src/db/seed/demo/guard.ts` for the demo seed's fuller refusal, which adds
// NODE_ENV=production and an explicit opt-in on top of this.
//
// STORY-169 review — `new URL(databaseUrl).hostname` is the WRONG parse.
// node-postgres (via `pg-connection-string`, vendored inside the `pg`
// dependency this repo already has) lets ANY query parameter override the
// parsed authority: `config.host = queryParam.host ?? url.hostname`. So
// `postgres://user:pw@localhost/db?host=prod-db.internal.example.com` reports
// hostname "localhost" under `new URL()`, while node-postgres actually opens
// a socket to prod-db.internal.example.com — the same trick spells the
// common Cloud SQL Unix-socket form,
// `postgres://u:p@localhost/db?host=/cloudsql/proj:region:inst`. Parsing with
// `pg.Client` instead reads the exact host node-postgres itself resolves to,
// including the query-param override, and constructing a `Client` performs
// no I/O — it only builds `ConnectionParameters`, it does not open a socket.
import { Client } from "pg";

/** Hostnames that are a developer's own machine, and nothing else. */
export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal", "postgres"]);

/**
 * The host a connection string ACTUALLY resolves to for node-postgres — via
 * `pg.Client`'s own parser, not `new URL(...).hostname` — or a fixed
 * placeholder for one that cannot be parsed at all. Never throws, so a
 * caller can report an unparseable URL by name rather than by crash.
 */
export function hostnameOf(databaseUrl: string): string {
  // An empty string is not "unset" (the guards check that separately) but it
  // is not a target either — `pg.Client` treats "" as "no connectionString
  // at all" and falls back to its own default host ("localhost", via
  // PGHOST), which would otherwise make a blank DATABASE_URL read as a valid
  // local target instead of the unparseable input it actually is.
  if (databaseUrl.trim() === "") {
    return "(unparseable DATABASE_URL)";
  }
  try {
    const client = new Client({ connectionString: databaseUrl });
    return client.host === "" ? "(unparseable DATABASE_URL)" : client.host;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/** Whether `databaseUrl` names a host in `LOCAL_HOSTS` — false for an unparseable URL, never a throw. */
export function isLocalTarget(databaseUrl: string): boolean {
  return LOCAL_HOSTS.has(hostnameOf(databaseUrl));
}
