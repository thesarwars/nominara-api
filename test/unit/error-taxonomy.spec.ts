import { describe, expect, it } from "vitest";
import { errorCodeSchema, type ErrorCode } from "../../contracts/common/error-code.schema.js";
import {
  SPEND_AND_LIMIT_REMEDIATION_KINDS,
  errorDetailsSchemaByCode,
} from "../../contracts/common/error-details.schema.js";
import { DOMAIN_ERROR_CLASSES, ERROR_STATUS_BY_CODE, DomainError, domainErrorFor } from "../../src/api/errors/domain-errors.js";

// STORY-024 T8 (RED step) — story scenarios 1 and 2, AC1/AC2/AC3.
// `src/api/errors/domain-errors.ts` does not exist yet: this file is RED at
// module resolution until T9 creates it, which is the correct and expected
// failure. It is listed here so the reason a run is red is never a guess.
//
// The status table below is transcribed from api-specification.md §2's
// taxonomy table and NOTHING ELSE — coding-standards.md §11 ("Numeric
// constants match the reference exactly — not a plausible neighbour").
// It is written out literally rather than derived from the implementation,
// because a table derived from the code under test cannot disagree with it.
const STATUS_FROM_SPECIFICATION: Record<ErrorCode, number> = {
  validation_failed: 400,
  unsupported_engine: 400,
  unauthenticated: 401,
  token_expired: 401,
  token_revoked: 401,
  step_up_required: 401,
  insufficient_credits: 402,
  forbidden: 403,
  workspace_mismatch: 403,
  project_out_of_scope: 403,
  entitlement_exceeded: 403,
  feature_not_in_plan: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  workspace_limit_reached: 409,
  price_changed: 409,
  domain_not_verified: 422,
  precondition_unmet: 422,
  unsafe_target: 422,
  rate_limited: 429,
  quota_exceeded: 429,
  daily_limit_reached: 429,
  capture_mode_unavailable: 451,
  engine_unavailable: 502,
  degraded: 503,
  retention_exceeded: 507,
};

describe("STORY-024 · scenario 1 — every taxonomy code has a typed domain error with §2's status", () => {
  it("the transcribed §2 status table covers exactly the 27 codes of errorCodeSchema (guards this file against going stale)", () => {
    expect(Object.keys(STATUS_FROM_SPECIFICATION).sort()).toEqual([...errorCodeSchema.options].sort());
  });

  it("AC1 — every code in the taxonomy has a typed domain error class", () => {
    expect(Object.keys(DOMAIN_ERROR_CLASSES).sort()).toEqual([...errorCodeSchema.options].sort());
  });

  it("ERROR_STATUS_BY_CODE agrees with §2 for every code, exactly", () => {
    expect(ERROR_STATUS_BY_CODE).toEqual(STATUS_FROM_SPECIFICATION);
  });

  // Constructed for real, not read off a table: a class whose declared status
  // disagrees with the status its instance actually reports would satisfy the
  // assertion above and still send the wrong number over the wire.
  it("each code constructs to an instance reporting its own code and §2's status", () => {
    for (const code of errorCodeSchema.options) {
      const instance = domainErrorFor(code);
      expect(instance, `${code} must construct a DomainError`).toBeInstanceOf(DomainError);
      expect(instance.code, `${code} instance must report its own code`).toBe(code);
      expect(instance.getStatus(), `${code} must report §2's status`).toBe(STATUS_FROM_SPECIFICATION[code]);
    }
  });

});

describe("STORY-024 · scenario 2 — the five spend-and-limit conditions are distinguishable (NFR-API-13)", () => {
  // api-specification.md §2's NFR-API-13: "402, 403 entitlement_exceeded,
  // 403 feature_not_in_plan, 429 quota_exceeded, and 429 daily_limit_reached
  // are five distinct, non-overlapping conditions… Conflating any two is a
  // specification violation, not a cosmetic issue."
  const SPEND_AND_LIMIT_CODES = [
    "insufficient_credits",
    "entitlement_exceeded",
    "feature_not_in_plan",
    "quota_exceeded",
    "daily_limit_reached",
  ] as const;

  it("all five are reachable as distinct codes", () => {
    expect(new Set(SPEND_AND_LIMIT_CODES).size).toBe(5);
    for (const code of SPEND_AND_LIMIT_CODES) {
      expect(DOMAIN_ERROR_CLASSES[code], `${code} must have a class`).toBeDefined();
    }
  });

  // Pairwise, not just "five distinct values in a set": the failure this rules
  // out is two codes sharing a remediation, and naming the offending PAIR is
  // what makes that diagnosable.
  it("the five remediation kinds are pairwise non-equal (decision D11)", () => {
    const kinds = SPEND_AND_LIMIT_CODES.map((code) => ({
      code,
      kind: domainErrorFor(code).remediation?.kind,
    }));

    for (const { code, kind } of kinds) {
      expect(kind, `${code} must carry a remediation kind`).toBeTruthy();
      expect(SPEND_AND_LIMIT_REMEDIATION_KINDS, `${code}'s kind must be one of D11's five`).toContain(kind);
    }

    for (let i = 0; i < kinds.length; i += 1) {
      for (let j = i + 1; j < kinds.length; j += 1) {
        expect(
          kinds[i]!.kind,
          `${kinds[i]!.code} and ${kinds[j]!.code} share remediation kind "${kinds[i]!.kind}" — NFR-API-13 violation`,
        ).not.toBe(kinds[j]!.kind);
      }
    }
  });

  // The four statuses are deliberately not all different (two 403s, two 429s),
  // so status alone can never be the discriminator a client switches on.
  // AC2 — "Every error carries the detail a client needs to remediate without
  // a second request — the limit and current value for a structural limit,
  // the required and available amounts plus purchasable options for a balance
  // failure, the reset time for a daily cap." Those are exactly these codes.
  // Fixtures are supplied here rather than defaulted in production code, so
  // what is proven is that the class THREADS details through to the wire and
  // pairs them with the right schema — not that production invented a sample.
  it("AC2 — each carries remediation detail satisfying its T7 details schema", () => {
    const FIXTURES: Partial<Record<(typeof SPEND_AND_LIMIT_CODES)[number], unknown>> = {
      insufficient_credits: {
        required: 500,
        available: 34,
        wallet: { included_balance: 0, purchased_balance: 34, reserved: 0, cycle_end: "2026-09-01" },
        packs: [{ key: "agency_vault", credits: 5000, price_usd: "50.00" }],
      },
      entitlement_exceeded: { key: "projects.max", limit: 3, current: 3 },
      feature_not_in_plan: { key: "sso.enabled", min_plan: "business" },
      daily_limit_reached: { action_code: "lookup", used: 50, limit: 50, resets_at: "2026-08-25T00:00:00Z" },
    };

    for (const [code, details] of Object.entries(FIXTURES)) {
      const schema = errorDetailsSchemaByCode[code as keyof typeof errorDetailsSchemaByCode];
      const thrown = domainErrorFor(code as (typeof SPEND_AND_LIMIT_CODES)[number], { details });

      expect(schema.safeParse(thrown.details).success, `${code} details must satisfy its T7 schema`).toBe(true);
    }
  });

  it("status alone cannot distinguish the five — the code must", () => {
    const statuses = SPEND_AND_LIMIT_CODES.map((code) => STATUS_FROM_SPECIFICATION[code]);
    expect(new Set(statuses).size).toBeLessThan(statuses.length);
  });
});

// Decision D12's mapping is asserted at the FILTER, not here: AC1 says "a
// filter maps it to the wire shape", and src/tenancy/errors.ts keeps throwing
// its own richer vocabulary unchanged. See src/api/filters/problem.filter.spec.ts.
