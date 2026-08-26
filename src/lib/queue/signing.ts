import { createHmac } from "node:crypto";
import { JobSignatureError } from "../../tenancy/errors.js";
import { canonicalJson, hmacSha256JobVerifier, type JobVerifier, type TenantJob } from "../../tenancy/with-tenant-job.js";

// STORY-030 — "Every tenant-scoped job payload is HMAC-SHA256 signed over
// its canonical JSON with a rotating queue key" + "Key rotation has an
// overlap window so in-flight jobs signed with the previous key still
// verify." Deliberately delegates to the EXISTING
// src/tenancy/with-tenant-job.ts primitives (hmacSha256JobVerifier,
// canonicalJson) rather than reimplementing canonicalization or HMAC
// comparison a second time.
//
// kid lives INSIDE the signed job data — the same design AUTH_TOKEN_ED25519_
// KID/_PREVIOUS_KID already establishes via auth.guard.ts's keysByKid map —
// so the verifier looks up which ONE of at most two configured keys to try,
// rather than blind-trying both in sequence. A kid matching neither
// configured key is rejected immediately, without computing an HMAC.

/** Producer side: signs `data`'s canonical JSON with `key`, hex-encoded — the exact form hmacSha256JobVerifier(key) verifies. Callers merge `kid` into `data` before calling this. */
export function signJobPayload(data: unknown, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalJson(data)).digest("hex");
}

export interface SigningKey {
  readonly kid: string;
  readonly key: Buffer;
}

export interface RotatingSigningKeys {
  readonly current: SigningKey;
  /** Present only during a rotation's overlap window — omit once every in-flight job signed under it has drained. */
  readonly previous?: SigningKey;
}

function readKid(job: TenantJob): string {
  const kid = (job.data as { kid?: unknown }).kid;
  if (typeof kid !== "string" || kid.length === 0) {
    throw new JobSignatureError("job payload is missing a signing key kid");
  }
  return kid;
}

/**
 * A tenant-scoped envelope can be a genuinely, correctly-signed payload that
 * still carries a malformed workspaceId (a producer bug, or a poisoned
 * Valkey entry that never needed to break the HMAC because it never
 * touched a signed field's semantic validity) — the HMAC alone does not
 * prove `workspaceId` is a usable tenant identifier, only that the bytes
 * match. Checked before context is ever set, same posture as readKid.
 */
function assertWorkspaceIdPresent(job: TenantJob): void {
  const workspaceId = (job.data as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new JobSignatureError("job payload is missing a usable workspaceId");
  }
}

/**
 * Reads `job.data.kid` and dispatches to the ONE matching configured key
 * (current or, during the overlap window, previous) — never tries a key the
 * kid did not claim. A kid that matches neither throws immediately.
 */
export function rotatingHmacJobVerifier(keys: RotatingSigningKeys): JobVerifier {
  const verifyCurrent = hmacSha256JobVerifier(keys.current.key);
  const verifyPrevious = keys.previous ? hmacSha256JobVerifier(keys.previous.key) : undefined;

  return (job: TenantJob): void => {
    const kid = readKid(job);
    assertWorkspaceIdPresent(job);

    if (kid === keys.current.kid) {
      verifyCurrent(job);
      return;
    }
    if (keys.previous && verifyPrevious && kid === keys.previous.kid) {
      verifyPrevious(job);
      return;
    }
    throw new JobSignatureError(`job payload signed with an unrecognized kid: ${kid}`);
  };
}
