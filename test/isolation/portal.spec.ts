import { describe, expect, it } from "vitest";
import { assertIso09PortalReadScope } from "./assertions/iso-09-portal-read-scope.js";
import { assertIso10PortalWriteDenied } from "./assertions/iso-10-portal-write-denied.js";
import { getAssertionContext } from "./support/context.js";
import { connectAsRole } from "./support/runtime-roles.js";
import { isRunnableForCurrentTarget } from "./support/target-guard.js";

describe("ISO-09 · portal cannot read outside its project scope, even within the same workspace", () => {
  it.skipIf(!isRunnableForCurrentTarget("ISO-09"))("holds across all 19 PORTAL_READABLE_TABLES (source_domains by domain, decision 83 c)", async () => {
    await expect(assertIso09PortalReadScope(getAssertionContext())).resolves.toBeUndefined();
  });
});

describe("ISO-10 · portal receives 42501 on INSERT/UPDATE/DELETE — grant-level denial", () => {
  it("holds across every discovered tenant table", async () => {
    await expect(assertIso10PortalWriteDenied(getAssertionContext())).resolves.toBeUndefined();
  });
});

describe("STORY-098 · the portal role cannot read sign-in codes, token hashes or view telemetry, even inside its own workspace", () => {
  it("share_token_email_codes, share_tokens and share_token_views return no row to nominara_portal under its own workspace's context", async () => {
    const ctx = getAssertionContext();
    const { a } = ctx.fixture;
    const portal = await connectAsRole(ctx.target, "nominara_portal");
    try {
      await portal.query("BEGIN");
      await portal.query("SELECT set_config('app.current_workspace_id', $1, true)", [a.workspaceId]);
      await portal.query("SELECT set_config('app.current_scope_projects', $1, true)", [a.projectIds.join(",")]);
      for (const table of ["share_token_email_codes", "share_tokens", "share_token_views"]) {
        const result = await portal.query(`SELECT 1 FROM ${table}`);
        expect(result.rowCount, `${table} must be invisible to the portal role`).toBe(0);
      }
      await portal.query("ROLLBACK");
    } finally {
      await portal.end();
    }
  });
});
