import { describe, expect, it } from "vitest";
import { hmacSha256JobVerifier, type TenantJob } from "../../../src/tenancy/with-tenant-job.js";
import { JobSignatureError } from "../../../src/tenancy/errors.js";
import { rotatingHmacJobVerifier, signJobPayload } from "../../../src/lib/queue/signing.js";

// STORY-030 T7/T8 + code-review fix — AC "Every tenant-scoped payload is
// signed over its canonical form with a rotating key, and the worker
// helper verifies the signature before any context call" + "Key rotation
// has an overlap window so in-flight jobs signed with the previous key
// still verify."
//
// kid lives INSIDE the signed job data (mirrors AUTH_TOKEN_ED25519_KID's
// precedent in auth.guard.ts's keysByKid map) so the verifier knows which
// of at most two configured keys to try — it looks the kid up and calls
// the ONE matching verifier directly, rather than blind-trying both keys
// in sequence. A kid that matches neither configured key is rejected
// immediately, without ever computing an HMAC.
//
// signing.ts delegates to the EXISTING src/tenancy/with-tenant-job.ts
// primitives (hmacSha256JobVerifier + canonicalJson) rather than
// reimplementing canonicalization — proven directly by scenario 1 below,
// which cross-checks signJobPayload's output against hmacSha256JobVerifier
// itself, not just against signing.ts's own verifier.

function job(data: Record<string, unknown>, signature: string): TenantJob {
  return { data: data as TenantJob["data"], signature };
}

describe("STORY-030 · signJobPayload — delegates to with-tenant-job.ts's own canonicalization", () => {
  it("produces a signature that hmacSha256JobVerifier (the existing primitive) itself accepts", () => {
    const key = Buffer.from("a".repeat(64), "hex");
    const data = { workspaceId: "ws_1", cell: "cell_1" };
    const signature = signJobPayload(data, key);

    expect(() => hmacSha256JobVerifier(key)(job(data, signature))).not.toThrow();
  });
});

describe("STORY-030 · rotatingHmacJobVerifier — kid-selected key, overlap window lets a previous-key job still verify", () => {
  const CURRENT_KID = "queue-key-2026-08";
  const PREVIOUS_KID = "queue-key-2026-07";
  const currentKey = Buffer.from("b".repeat(64), "hex");
  const previousKey = Buffer.from("c".repeat(64), "hex");
  const wrongKey = Buffer.from("d".repeat(64), "hex");

  const current = { kid: CURRENT_KID, key: currentKey };
  const previous = { kid: PREVIOUS_KID, key: previousKey };

  function dataSignedWith(kid: string) {
    return { workspaceId: "ws_1", cell: "cell_1", kid };
  }

  it("accepts a job signed with the CURRENT key and carrying the current kid", () => {
    const verify = rotatingHmacJobVerifier({ current });
    const data = dataSignedWith(CURRENT_KID);
    const signature = signJobPayload(data, currentKey);
    expect(() => verify(job(data, signature))).not.toThrow();
  });

  it("accepts a job signed with the PREVIOUS key and carrying the previous kid, while the overlap window is configured", () => {
    const verify = rotatingHmacJobVerifier({ current, previous });
    const data = dataSignedWith(PREVIOUS_KID);
    const signature = signJobPayload(data, previousKey);
    expect(() => verify(job(data, signature))).not.toThrow();
  });

  it("rejects a previous-kid job once the overlap window ends (no previous key configured)", () => {
    const verify = rotatingHmacJobVerifier({ current });
    const data = dataSignedWith(PREVIOUS_KID);
    const signature = signJobPayload(data, previousKey);
    expect(() => verify(job(data, signature))).toThrow(JobSignatureError);
  });

  it("rejects a job whose kid matches the current kid but was signed with the wrong key", () => {
    const verify = rotatingHmacJobVerifier({ current, previous });
    const data = dataSignedWith(CURRENT_KID);
    const signature = signJobPayload(data, wrongKey);
    expect(() => verify(job(data, signature))).toThrow(JobSignatureError);
  });

  it("rejects a tampered payload even though it was originally signed with the current key — a poisoned entry cannot redirect a worker", () => {
    const verify = rotatingHmacJobVerifier({ current, previous });
    const data = dataSignedWith(CURRENT_KID);
    const signature = signJobPayload(data, currentKey);
    const tampered = { ...data, workspaceId: "ws_ATTACKER" };
    expect(() => verify(job(tampered, signature))).toThrow(JobSignatureError);
  });

  it("rejects a tampered payload signed under the previous key too — the overlap window does not weaken tamper detection", () => {
    const verify = rotatingHmacJobVerifier({ current, previous });
    const data = dataSignedWith(PREVIOUS_KID);
    const signature = signJobPayload(data, previousKey);
    const tampered = { ...data, workspaceId: "ws_ATTACKER" };
    expect(() => verify(job(tampered, signature))).toThrow(JobSignatureError);
  });

  it("rejects immediately when kid matches neither configured key — never blind-tries both keys", () => {
    const verify = rotatingHmacJobVerifier({ current, previous });
    // Deliberately signed with the CURRENT key, but the kid claims to be
    // something unrecognized — a naive "try current, then try previous"
    // implementation would still accept this. It must not.
    const data = dataSignedWith("unrecognized-kid");
    const signature = signJobPayload(data, currentKey);
    expect(() => verify(job(data, signature))).toThrow(JobSignatureError);
  });

  it("rejects immediately when kid is missing entirely from the job payload", () => {
    const verify = rotatingHmacJobVerifier({ current, previous });
    const data = { workspaceId: "ws_1", cell: "cell_1" };
    const signature = signJobPayload(data, currentKey);
    expect(() => verify(job(data, signature))).toThrow(JobSignatureError);
  });
});

// STORY-030 Phase C — a poisoned/malformed queue entry is not always a
// TAMPERED one: a genuinely, correctly-signed payload can still carry a
// null/missing workspaceId (a producer-side bug, or a poisoned Valkey entry
// crafted without ever needing to break the HMAC). Either way the worker
// must reject it before any context call — the same "fail closed" posture
// as a bad kid or a bad signature, never proceeding with an ambiguous
// tenant scope.
describe("STORY-030 · rotatingHmacJobVerifier — malformed workspaceId is rejected even with a genuinely valid signature", () => {
  const CURRENT_KID = "queue-key-2026-08";
  const currentKey = Buffer.from("b".repeat(64), "hex");
  const current = { kid: CURRENT_KID, key: currentKey };

  it("rejects a job whose workspaceId is null, even though the signature itself verifies for that exact payload", () => {
    const verify = rotatingHmacJobVerifier({ current });
    const data = { workspaceId: null, cell: "cell_1", kid: CURRENT_KID };
    const signature = signJobPayload(data, currentKey);
    expect(() => verify(job(data as unknown as Record<string, unknown>, signature))).toThrow(JobSignatureError);
  });

  it("rejects a job whose workspaceId is missing entirely, even though the signature itself verifies for that exact payload", () => {
    const verify = rotatingHmacJobVerifier({ current });
    const data = { cell: "cell_1", kid: CURRENT_KID };
    const signature = signJobPayload(data, currentKey);
    expect(() => verify(job(data, signature))).toThrow(JobSignatureError);
  });

  it("rejects a job whose workspaceId is an empty string, even though the signature itself verifies for that exact payload", () => {
    const verify = rotatingHmacJobVerifier({ current });
    const data = { workspaceId: "", cell: "cell_1", kid: CURRENT_KID };
    const signature = signJobPayload(data, currentKey);
    expect(() => verify(job(data, signature))).toThrow(JobSignatureError);
  });
});
