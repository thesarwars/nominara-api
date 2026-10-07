import { describe, expect, it } from "vitest";
import { assertIso06Census } from "./assertions/iso-06-census.js";
import { assertIso05PolicyShape } from "./assertions/iso-05-policy-shape.js";
import { assertIso07NoBypassRls } from "./assertions/iso-07-no-bypassrls.js";
import { assertIso16NoMaterializedViews } from "./assertions/iso-16-no-matviews.js";
import { assertIso23ViewsSecurityInvoker } from "./assertions/iso-23-views-security-invoker.js";
import { assertIso17PartitionRlsApplied } from "./assertions/iso-17-partition-rls-applied.js";
import { getAssertionContext } from "./support/context.js";

// STORY-012 Phase 1 (catalog) — order matters, ISO-06 first: the census is
// the guard on every other assertion's table-set assumption.
describe("ISO-06 · census — 61 tenant / 18 global / 79 total, independently derived", () => {
  it("matches the fixed numbers and cross-checks against src/db/conventions.ts", async () => {
    await expect(assertIso06Census(getAssertionContext())).resolves.toBeUndefined();
  });
});

describe("ISO-05 · every FOR ALL policy has a with_check; every tenant table and partition child is forced", () => {
  it("holds across the live schema", async () => {
    await expect(assertIso05PolicyShape(getAssertionContext())).resolves.toBeUndefined();
  });
});

describe("ISO-07 · no runtime role holds BYPASSRLS except nominara_breakglass", () => {
  it("holds across every runtime + breakglass role", async () => {
    await expect(assertIso07NoBypassRls(getAssertionContext())).resolves.toBeUndefined();
  });
});

describe("ISO-16 · no materialized view exists; migration lint enforces it", () => {
  it("holds against the live schema and every committed migration file", async () => {
    await expect(assertIso16NoMaterializedViews(getAssertionContext())).resolves.toBeUndefined();
  });
});

// STORY-152 — next to ISO-16 deliberately: same hazard, different relkind. A
// plain view without security_invoker executes as its OWNER and bypasses RLS
// exactly as a matview does.
describe("ISO-23 · every view in `public` carries security_invoker=true", () => {
  it("holds against the live schema, and finds at least one view to check", async () => {
    await expect(assertIso23ViewsSecurityInvoker(getAssertionContext())).resolves.toBeUndefined();
  });
});

describe("ISO-17 · a partition the maintenance job creates carries app.apply_tenant_rls before it takes writes", () => {
  it("queried directly, with no tenant context, as nominara_app — zero rows", async () => {
    await expect(assertIso17PartitionRlsApplied(getAssertionContext())).resolves.toBeUndefined();
  });
});
