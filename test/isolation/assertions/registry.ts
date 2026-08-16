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
import { assertIso13CacheNamespacing, iso13Breaker } from "./iso-13-cache-namespace.js";
import { assertIso14ObjectNamespacing, iso14Breaker } from "./iso-14-object-namespace.js";
import { assertIso15AggregateAnonymity, iso15Breaker } from "./iso-15-aggregate-anonymity.js";
import { assertIso16NoMaterializedViews, iso16Breaker } from "./iso-16-no-matviews.js";
import { assertIso17AgainstMissingApplyTenantRls, assertIso17PartitionRlsApplied, iso17Breaker } from "./iso-17-partition-rls-applied.js";

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
    breaker: iso13Breaker,
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
];

// STORY-012 T24 · D-6 — ISOLATION_TARGET=staging runs ONLY the read-only,
// fixture-independent subset (no seeding happens against staging at all —
// see global-setup.ts's staging branch).
export function selectAssertionsForTarget(target: "local" | "pooled" | "staging"): readonly AssertionEntry[] {
  if (target !== "staging") return ASSERTIONS;
  return ASSERTIONS.filter((entry) => entry.readOnly && !entry.needsFixture);
}
