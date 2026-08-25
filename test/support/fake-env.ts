// STORY-023 T2 (RED step) — the fake-env block src/api/api.module.spec.ts
// established for booting the REAL, deployed ApiModule without a live
// Postgres connection (DbModule's PG_POOL factory only constructs a LAZY
// pg.Pool at this stage — no connection is attempted merely by module
// construction). Shared here rather than several near-identical 11-line
// copies across the contract-pipeline spec files, which is exactly the
// kind of duplication that drifts one env var at a time.
//
// Callers still own capturing/restoring `process.env` around this call
// (`const originalEnv = { ...process.env }` in `beforeEach`, restored in
// `afterEach`) — this function only ever ADDS keys, never snapshots or
// restores anything itself.
export function applyFakeApiEnv(): void {
  process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
  process.env.DATABASE_URL_POOLED = "postgres://fake:fake@localhost:5432/fake";
  process.env.WEBAUTHN_RP_ID = "localhost";
  process.env.WEBAUTHN_RP_NAME = "Nominara";
  process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
  process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
  process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
  process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
  process.env.CSRF_SECRET = "test-csrf-secret";
  process.env.WORKSPACE_DEK_WRAPPING_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
  process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
  // STORY-016 added these two as REQUIRED (src/config/env.ts:40-41); without
  // them the real ApiModule cannot be constructed at all.
  process.env.OTP_EMAIL_HASH_PEPPER = "test-otp-email-hash-pepper";
  process.env.OTP_EMAIL_FROM = "Nominara <no-reply@nominara.test>";
  process.env.VALKEY_CACHE_URL = "redis://localhost:6379";
}
