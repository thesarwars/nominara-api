// Regenerates the exact JSON literals embedded in
// src/db/migrations/sql/0002_identity_tenancy_billing.up.sql's plans seed.
// Run with `npx tsx scripts/print-entitlements.mts` after editing
// src/db/seed/plan-entitlements.ts, then paste the output back into a NEW
// migration that updates the existing rows — this migration's INSERT is
// already applied wherever it's run and is not meant to be edited in place.
import { PLAN_CATALOG, PLAN_ENTITLEMENTS } from "../src/db/seed/plan-entitlements.js";

for (const plan of PLAN_CATALOG) {
  console.log(`--- ${plan.key} ---`);
  console.log(JSON.stringify(PLAN_ENTITLEMENTS[plan.key]));
}
