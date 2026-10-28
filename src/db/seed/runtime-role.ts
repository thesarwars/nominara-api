import type { ClientBase } from "pg";
import { DemoSeedRefusedError } from "./demo/guard.js";

// Moved here from src/db/seed-demo.ts (STORY-169) by STORY-004 so the
// synthetic seed (`pnpm db:seed`) runs the identical check: the first
// statement inside the tenant transaction proves the pooled connection is
// `nominara_app` with RLS in force, before any tenant write.

/**
 * ⚠ REVIEW FIX — `assertDemoSeedAllowed` checks only hostnames and the
 * opt-in; it has no idea which Postgres ROLE `DATABASE_URL_POOLED`
 * actually authenticates as. If it happens to name the migration owner or
 * the superuser (easy when a developer exports connection strings by
 * hand), every write this seed makes runs with RLS BYPASSED — "RLS is the
 * real boundary, not a convention on the owner connection" (this file's
 * own header) stops being true for every tenant write the seed makes, and
 * nothing would report it. `test/isolation/assertions/iso-00-anti-
 * vacuity.ts` refuses a superuser/bypassrls connection for the identical
 * reason before trusting anything else it asserts; this is the same check,
 * run as the FIRST statement inside the ambient tenant transaction, before
 * any tenant write.
 */
export async function assertPooledConnectionIsRuntimeApp(tx: ClientBase, what = "demo data"): Promise<void> {
  const result = await tx.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DemoSeedRefusedError(
      `refusing to seed ${what}: could not resolve a pg_roles row for DATABASE_URL_POOLED's connected role.`,
    );
  }
  if (row.rolname !== "nominara_app" || row.rolsuper || row.rolbypassrls) {
    // Each ternary's OWN colon is kept OUT of a template literal that opens
    // with an interpolation — ISO-13's cache-key scanner (test/isolation/
    // assertions/iso-13-cache-namespace.ts) flags a literal opening with an
    // interpolation and carrying two colons as an un-namespaced cache key
    // construction site, and it cannot tell a ternary's colon from a
    // key-segment separator by regex alone; the scanner reads raw source,
    // so even a code example in a COMMENT can trip it. Two plain variables,
    // assigned outside any template literal, keep the message unchanged
    // while staying off that pattern — the same avoidance
    // `denormalizeProject`'s `shiftDate` documents.
    const superuserNote = row.rolsuper ? " (SUPERUSER)" : "";
    const bypassrlsNote = row.rolbypassrls ? " (BYPASSRLS)" : "";
    throw new DemoSeedRefusedError(
      `refusing to seed ${what}: DATABASE_URL_POOLED is authenticated as "${row.rolname}"` +
        `${superuserNote}${bypassrlsNote}, not nominara_app with RLS in ` +
        "force. Every tenant write this seed makes must run through the real runtime role, or RLS is not actually " +
        "the boundary protecting other workspaces from it.",
    );
  }
}
