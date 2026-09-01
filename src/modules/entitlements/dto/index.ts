// STORY-069 — DTOs are ALWAYS derived from a zod schema in contracts/, never
// hand-written (coding-standards.md §2). This module's contract is
// contracts/entitlements/resolved-entitlements.schema.ts.
export {
  resolvedEntitlementsResponseSchema,
  type ResolvedEntitlement,
  type ResolvedEntitlementsResponse,
} from "../../../../contracts/entitlements/resolved-entitlements.schema.js";
