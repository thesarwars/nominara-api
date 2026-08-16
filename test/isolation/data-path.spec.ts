import { describe, expect, it } from "vitest";
import { assertIso01NoContextZeroRows } from "./assertions/iso-01-no-context-zero-rows.js";
import { assertIso02TenantIsolation } from "./assertions/iso-02-tenant-a-no-b-rows.js";
import { assertIso03InsertForeignTenantRaises } from "./assertions/iso-03-insert-foreign-tenant-raises.js";
import { assertIso04UpdateCrossTenant } from "./assertions/iso-04-update-cross-tenant.js";
import { assertIso08FuzzReplay } from "./assertions/iso-08-fuzz-replay.js";
import { getAssertionContext } from "./support/context.js";
import { isRunnableForCurrentTarget } from "./support/target-guard.js";

// STORY-012 Phase 2 — data-path assertions, always through the REAL runtime
// roles, never a superuser.
//
// nominara_worker holds the SAME grants as nominara_app (SELECT/INSERT/
// UPDATE/DELETE on every tenant table, per 0005_roles_grants_and_pooling.up
// .sql) and is covered by the SAME generated RLS policy per table, so every
// one of ISO-01/02/03/04/08 also runs under it. nominara_report holds SELECT
// only, so it is exercised for the read-only assertions (ISO-01/02/08) but
// NOT the write ones (ISO-03/04): a write under nominara_report fails on the
// GRANT before ever reaching the RLS policy those two assertions test, so
// running them there would not exercise anything real.
const READ_ONLY_ROLES = ["nominara_app", "nominara_worker", "nominara_report"] as const;
const READ_WRITE_ROLES = ["nominara_app", "nominara_worker"] as const;

describe("ISO-01 · zero rows with no context, every tenant table + partition child", () => {
  for (const role of READ_ONLY_ROLES) {
    it.skipIf(!isRunnableForCurrentTarget("ISO-01"))(`holds under ${role}`, async () => {
      await expect(assertIso01NoContextZeroRows(getAssertionContext(), role)).resolves.toBeUndefined();
    });
  }
});

describe("ISO-02 · tenant A's context returns exactly A's rows, zero foreign", () => {
  for (const role of READ_ONLY_ROLES) {
    it.skipIf(!isRunnableForCurrentTarget("ISO-02"))(`holds for all three seeded tenants under ${role}`, async () => {
      await expect(assertIso02TenantIsolation(getAssertionContext(), role)).resolves.toBeUndefined();
    });
  }
});

describe("ISO-03 · INSERT under A's context with B's workspace_id raises 42501", () => {
  for (const role of READ_WRITE_ROLES) {
    it.skipIf(!isRunnableForCurrentTarget("ISO-03"))(`raises the exact SQLSTATE, not message text, under ${role}`, async () => {
      await expect(assertIso03InsertForeignTenantRaises(getAssertionContext(), role)).resolves.toBeUndefined();
    });
  }
});

describe("ISO-04 · UPDATE moving a row to another tenant affects 0 rows OR raises", () => {
  for (const role of READ_WRITE_ROLES) {
    it.skipIf(!isRunnableForCurrentTarget("ISO-04"))(`holds the explicit disjunction under ${role}`, async () => {
      await expect(assertIso04UpdateCrossTenant(getAssertionContext(), role)).resolves.toBeUndefined();
    });
  }
});

describe("ISO-08 · 500 randomised cross-tenant identifier replays yield only refusals", () => {
  for (const role of READ_ONLY_ROLES) {
    it.skipIf(!isRunnableForCurrentTarget("ISO-08"))(`never returns a row belonging to the wrong tenant under ${role}`, async () => {
      await expect(assertIso08FuzzReplay(getAssertionContext(), role)).resolves.toBeUndefined();
    });
  }
});
