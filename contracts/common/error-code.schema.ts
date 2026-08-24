import { z } from "zod";

// STORY-023 AC1 (T1) — the error-code union referenced by
// `problem-details.schema.ts`'s `error.code` member and, once T3 lands, by
// the generated OpenAPI document and the published `@nominara/client`.
//
// api-specification.md §2 "Error taxonomy" (as corrected by task T0d /
// decision D2) enumerates exactly 27 `code` values across its table. Per the
// coordinator's decision recorded in STORY-023's execution plan, all 27 are
// shipped here now rather than split across T1/T7 — a partial enum would
// flow into the generated specification and the published client within the
// same run, publishing a knowingly-wrong union, which is exactly what AC5
// and the drift gate exist to prevent.
//
// This is a closed union, not a per-module list: a new code is a specification
// change to §2 first, this file second — never the other way round.
export const errorCodeSchema = z.enum([
  // 400
  "validation_failed",
  "unsupported_engine",
  // 401
  "unauthenticated",
  "token_expired",
  "token_revoked",
  "step_up_required",
  // 402
  "insufficient_credits",
  // 403
  "forbidden",
  "workspace_mismatch",
  "project_out_of_scope",
  "entitlement_exceeded",
  "feature_not_in_plan",
  // 404
  "not_found",
  // 409
  "conflict",
  "idempotency_conflict",
  "workspace_limit_reached",
  "price_changed",
  // 422
  "domain_not_verified",
  "precondition_unmet",
  "unsafe_target",
  // 429
  "rate_limited",
  "quota_exceeded",
  "daily_limit_reached",
  // 451
  "capture_mode_unavailable",
  // 502
  "engine_unavailable",
  // 503
  "degraded",
  // 507
  "retention_exceeded",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
