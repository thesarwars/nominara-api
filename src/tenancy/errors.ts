// STORY-011 — the two typed errors this module's guardrails raise. Kept
// separate from tenant-context.ts/query-guard.ts/with-tenant-job.ts so any
// of those can import the error types without a circular dependency.

/**
 * Thrown by src/tenancy/query-guard.ts when a tenant-scoped table is queried
 * outside a context-carrying transaction (i.e. outside
 * withTenantContext/withTenantJob). Converts "forgot the interceptor" from a
 * silent cross-tenant data leak into a loud failure in CI.
 */
export class TenantContextMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantContextMissingError";
  }
}

/**
 * Thrown by a JobVerifier (see with-tenant-job.ts) when a queue job's payload
 * signature does not verify. Raised BEFORE any set_config call, so a
 * tampered/poisoned queue entry can never redirect a worker into another
 * tenant's context.
 */
export class JobSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobSignatureError";
  }
}
