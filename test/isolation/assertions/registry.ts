import type { AssertionContext } from "../support/assertion-context.js";
import type { Breaker } from "../support/breakers.js";

import { assertIso00AntiVacuity, iso00Breaker } from "./iso-00-anti-vacuity.js";
import { assertIso01NoContextZeroRows, iso01Breaker } from "./iso-01-no-context-zero-rows.js";
import { assertIso02TenantIsolation, iso02Breaker } from "./iso-02-tenant-a-no-b-rows.js";
import { assertIso03InsertForeignTenantRaises, iso03Breaker } from "./iso-03-insert-foreign-tenant-raises.js";
import { assertIso04UpdateCrossTenant, iso04Breaker } from "./iso-04-update-cross-tenant.js";
import { assertIso05PolicyShape, iso05Breaker } from "./iso-05-policy-shape.js";
import { assertIso06Census, iso06Breaker } from "./iso-06-census.js";
import { assertIso07NoBypassRls, iso07Breaker } from "./iso-07-no-bypassrls.js";
import { assertIso08FuzzReplay, iso08Breaker } from "./iso-08-fuzz-replay.js";
import { assertIso09PortalReadScope, iso09Breaker } from "./iso-09-portal-read-scope.js";
import { assertIso10PortalWriteDenied, iso10Breaker } from "./iso-10-portal-write-denied.js";
import { assertIso11TamperedJobRejectedPreContext, assertIso11AgainstBrokenOrdering, iso11Breaker } from "./iso-11-tampered-job-signature.js";
import { assertIso12EnvelopeAad, assertIso12AgainstAadBlindDecrypt, iso12Breaker } from "./iso-12-envelope-aad.js";
import { assertIso13CacheNamespacing, iso13ConstructorBreaker } from "./iso-13-cache-namespace.js";
import { assertIso14ObjectNamespacing, iso14Breaker } from "./iso-14-object-namespace.js";
import { assertIso15AggregateAnonymity, iso15Breaker } from "./iso-15-aggregate-anonymity.js";
import { assertIso16NoMaterializedViews, iso16Breaker } from "./iso-16-no-matviews.js";
import { assertIso23ViewsSecurityInvoker, iso23Breaker } from "./iso-23-views-security-invoker.js";
import { assertIso17AgainstMissingApplyTenantRls, assertIso17PartitionRlsApplied, iso17Breaker } from "./iso-17-partition-rls-applied.js";
import { assertIso18ActorSelfScopedMultiActor, iso18Breaker } from "./iso-18-actor-self-scoped-multi-actor.js";
import { assertIso19NoGucsZeroRows, iso19Breaker } from "./iso-19-actor-scoped-no-context-zero-rows.js";
import { assertIso20ActorPolicyInertUnderTenantContext, iso20Breaker } from "./iso-20-actor-policy-inert-under-tenant-context.js";
import { assertIso21ActorOnlyWritesDenied, assertIso21AgainstMissingReadOnly, iso21Breaker } from "./iso-21-actor-only-writes-denied.js";
import { assertIso22ActorOnlyFuzzReplay, iso22Breaker } from "./iso-22-actor-only-fuzz-replay.js";
import { assertIso26ShareLookupReturnsOnlyHashedRow, iso26Breaker } from "./iso-26-share-lookup-returns-only-hashed-row.js";
import { assertIso24DefinerOwnerNoMembers, iso24Breaker } from "./iso-24-definer-owner-no-members.js";
import { assertIso25ShareLookupDefinerShape, iso25Breaker } from "./iso-25-share-lookup-definer-shape.js";
import { assertIso27MaintenanceDefinerShape, iso27Breaker } from "./iso-27-maintenance-definer-shape.js";

// STORY-012 — the single place every registered assertion AND its paired
// breaker are aggregated. test/isolation/meta/breaker-matrix.spec.ts (T27)
// asserts this registry's size matches the number of assertion modules and
// that every entry has exactly one breaker — the Definition of Done's
// literal requirement, enforced structurally rather than by hand-count.

export type NeedsDatabase = boolean;

export interface AssertionEntry {
  readonly id: string;
  readonly needsDatabase: NeedsDatabase;
  readonly readOnly: boolean;
  /** Whether the assertion reads ctx.fixture (the synthetic three-tenant seed) — staging mode (T24/D-6) has no such fixture. */
  readonly needsFixture: boolean;
  /** The assertion actually exercised under a breaker (may differ from `assert` when the property is pure-code, e.g. ISO-12). */
  readonly assertUnderBreaker: (ctx: AssertionContext) => Promise<void>;
  readonly assert: (ctx: AssertionContext) => Promise<void>;
  readonly breaker: Breaker;
  /**
   * What breaker-execution.spec.ts requires the thrown failure to match —
   * defaults to `^ISO-NN\b`. Overridden only when the assertion's own check
   * legitimately delegates to a shared support module whose errors carry a
   * different, but still non-incidental, prefix (e.g. ISO-06's census relies
   * on discovery.ts's own "a table cannot ship without an explicit isolation
   * decision" check).
   */
  readonly ownFailurePattern?: RegExp;
}

async function ignoreCtx(fn: () => Promise<void> | void): Promise<void> {
  await fn();
}

export const ASSERTIONS: readonly AssertionEntry[] = [
  { id: "ISO-00", needsDatabase: true, readOnly: true, needsFixture: true, assert: assertIso00AntiVacuity, assertUnderBreaker: assertIso00AntiVacuity, breaker: iso00Breaker },
  { id: "ISO-01", needsDatabase: true, readOnly: true, needsFixture: false, assert: assertIso01NoContextZeroRows, assertUnderBreaker: assertIso01NoContextZeroRows, breaker: iso01Breaker },
  { id: "ISO-02", needsDatabase: true, readOnly: true, needsFixture: true, assert: assertIso02TenantIsolation, assertUnderBreaker: assertIso02TenantIsolation, breaker: iso02Breaker },
  { id: "ISO-03", needsDatabase: true, readOnly: false, needsFixture: true, assert: assertIso03InsertForeignTenantRaises, assertUnderBreaker: assertIso03InsertForeignTenantRaises, breaker: iso03Breaker },
  { id: "ISO-04", needsDatabase: true, readOnly: false, needsFixture: true, assert: assertIso04UpdateCrossTenant, assertUnderBreaker: assertIso04UpdateCrossTenant, breaker: iso04Breaker },
  { id: "ISO-05", needsDatabase: true, readOnly: true, needsFixture: false, assert: assertIso05PolicyShape, assertUnderBreaker: assertIso05PolicyShape, breaker: iso05Breaker },
  // ownFailurePattern widened: computeCensus() legitimately throws via
  // discovery.ts's own "table cannot ship without an explicit isolation
  // decision" check (discoverTenantTables) before ISO-06's own code runs —
  // that IS the census's guard, not an incidental error.
  {
    id: "ISO-06",
    needsDatabase: true,
    readOnly: true,
    needsFixture: false,
    assert: assertIso06Census,
    assertUnderBreaker: assertIso06Census,
    breaker: iso06Breaker,
    ownFailurePattern: /^(ISO-06|discovery)\b/,
  },
  { id: "ISO-07", needsDatabase: true, readOnly: true, needsFixture: false, assert: assertIso07NoBypassRls, assertUnderBreaker: assertIso07NoBypassRls, breaker: iso07Breaker },
  { id: "ISO-08", needsDatabase: true, readOnly: true, needsFixture: true, assert: assertIso08FuzzReplay, assertUnderBreaker: assertIso08FuzzReplay, breaker: iso08Breaker },
  { id: "ISO-09", needsDatabase: true, readOnly: true, needsFixture: true, assert: assertIso09PortalReadScope, assertUnderBreaker: assertIso09PortalReadScope, breaker: iso09Breaker },
  // readOnly: false — ISO-10 issues INSERT/UPDATE/DELETE probes (rolled back
  // explicitly, see iso-10-portal-write-denied.ts), so it is excluded from
  // the staging read-only subset even though every probe is reverted.
  { id: "ISO-10", needsDatabase: true, readOnly: false, needsFixture: false, assert: assertIso10PortalWriteDenied, assertUnderBreaker: assertIso10PortalWriteDenied, breaker: iso10Breaker },
  {
    id: "ISO-11",
    needsDatabase: false,
    readOnly: true,
    needsFixture: false,
    assert: () => ignoreCtx(assertIso11TamperedJobRejectedPreContext),
    assertUnderBreaker: () => ignoreCtx(assertIso11AgainstBrokenOrdering),
    breaker: iso11Breaker,
  },
  {
    id: "ISO-12",
    needsDatabase: true,
    readOnly: true,
    needsFixture: false,
    assert: assertIso12EnvelopeAad,
    assertUnderBreaker: assertIso12AgainstAadBlindDecrypt,
    breaker: iso12Breaker,
  },
  {
    id: "ISO-13",
    needsDatabase: false,
    readOnly: true,
    needsFixture: false,
    assert: () => ignoreCtx(assertIso13CacheNamespacing),
    assertUnderBreaker: () => ignoreCtx(assertIso13CacheNamespacing),
    // STORY-026 audit fix — the breaker now removes the workspace segment from
    // the REAL constructor rather than planting a literal in src/. The old one
    // exercised the scanner, which the assertion's own fixture self-test
    // already proves is not vacuous; nothing proved the CONSTRUCTORS were
    // guarded, and deleting the tenant boundary left this gate green.
    breaker: iso13ConstructorBreaker,
  },
  {
    id: "ISO-14",
    needsDatabase: false,
    readOnly: true,
    needsFixture: false,
    assert: () => ignoreCtx(assertIso14ObjectNamespacing),
    assertUnderBreaker: () => ignoreCtx(assertIso14ObjectNamespacing),
    breaker: iso14Breaker,
  },
  { id: "ISO-15", needsDatabase: true, readOnly: false, needsFixture: true, assert: assertIso15AggregateAnonymity, assertUnderBreaker: assertIso15AggregateAnonymity, breaker: iso15Breaker },
  { id: "ISO-16", needsDatabase: true, readOnly: true, needsFixture: false, assert: assertIso16NoMaterializedViews, assertUnderBreaker: assertIso16NoMaterializedViews, breaker: iso16Breaker },
  // STORY-152 — the plain-view sibling of ISO-16. Read-only and fixture-free
  // for the same reason: it inspects the SCHEMA, not any tenant's rows.
  { id: "ISO-23", needsDatabase: true, readOnly: true, needsFixture: false, assert: assertIso23ViewsSecurityInvoker, assertUnderBreaker: assertIso23ViewsSecurityInvoker, breaker: iso23Breaker },
  // readOnly: false — creates a partition and inserts a probe row (DDL + a
  // write), so it is excluded from the staging read-only subset like ISO-10.
  {
    id: "ISO-17",
    needsDatabase: true,
    readOnly: false,
    needsFixture: false,
    assert: assertIso17PartitionRlsApplied,
    assertUnderBreaker: assertIso17AgainstMissingApplyTenantRls,
    breaker: iso17Breaker,
  },
  // STORY-021 / ADR-0001 — actor-self-scoped RLS policy class (see
  // docs/adr/ADR-0001-actor-self-scoped-rls-for-cross-workspace-self-reads.md).
  {
    id: "ISO-18",
    needsDatabase: true,
    readOnly: false,
    needsFixture: true,
    assert: assertIso18ActorSelfScopedMultiActor,
    assertUnderBreaker: assertIso18ActorSelfScopedMultiActor,
    breaker: iso18Breaker,
  },
  {
    id: "ISO-19",
    needsDatabase: true,
    readOnly: true,
    needsFixture: false,
    assert: assertIso19NoGucsZeroRows,
    assertUnderBreaker: assertIso19NoGucsZeroRows,
    breaker: iso19Breaker,
  },
  {
    id: "ISO-20",
    needsDatabase: true,
    readOnly: true,
    needsFixture: true,
    assert: assertIso20ActorPolicyInertUnderTenantContext,
    assertUnderBreaker: assertIso20ActorPolicyInertUnderTenantContext,
    breaker: iso20Breaker,
  },
  // readOnly: false — issues INSERT/UPDATE/DELETE probes (each rolled back
  // automatically via withActorContext's own catch/rollback), same posture
  // as ISO-03/04.
  {
    id: "ISO-21",
    needsDatabase: true,
    readOnly: false,
    needsFixture: true,
    assert: assertIso21ActorOnlyWritesDenied,
    assertUnderBreaker: assertIso21AgainstMissingReadOnly,
    breaker: iso21Breaker,
  },
  {
    id: "ISO-22",
    needsDatabase: true,
    readOnly: true,
    needsFixture: true,
    assert: assertIso22ActorOnlyFuzzReplay,
    assertUnderBreaker: assertIso22ActorOnlyFuzzReplay,
    breaker: iso22Breaker,
  },
  // ADR-0002 — the share-token lookup definer: nobody is a member of its owner role, and the function's shape holds.
  // Both inspect the catalog only (no tenant rows), hence read-only and fixture-free.
  { id: "ISO-24", needsDatabase: true, readOnly: true, needsFixture: false, assert: assertIso24DefinerOwnerNoMembers, assertUnderBreaker: assertIso24DefinerOwnerNoMembers, breaker: iso24Breaker },
  { id: "ISO-25", needsDatabase: true, readOnly: true, needsFixture: false, assert: assertIso25ShareLookupDefinerShape, assertUnderBreaker: assertIso25ShareLookupDefinerShape, breaker: iso25Breaker },
  // The lookup returns only the hashed token's row. Needs the three-tenant fixture (tokens to leak) and is read-only.
  { id: "ISO-26", needsDatabase: true, readOnly: true, needsFixture: true, assert: assertIso26ShareLookupReturnsOnlyHashedRow, assertUnderBreaker: assertIso26ShareLookupReturnsOnlyHashedRow, breaker: iso26Breaker },
  // STORY-013 r2 / ADR-0004 — the count-only maintenance definers: owner, EXECUTE holders, pinned search_path, counts-only output types.
  { id: "ISO-27", needsDatabase: true, readOnly: true, needsFixture: false, assert: assertIso27MaintenanceDefinerShape, assertUnderBreaker: assertIso27MaintenanceDefinerShape, breaker: iso27Breaker },
];

// STORY-012 T24 · D-6 — ISOLATION_TARGET=staging runs ONLY the read-only,
// fixture-independent subset (no seeding happens against staging at all —
// see global-setup.ts's staging branch).
export function selectAssertionsForTarget(target: "local" | "pooled" | "staging"): readonly AssertionEntry[] {
  if (target !== "staging") return ASSERTIONS;
  return ASSERTIONS.filter((entry) => entry.readOnly && !entry.needsFixture);
}
