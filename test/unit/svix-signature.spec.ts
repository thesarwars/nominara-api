import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SVIX_TOLERANCE_SECONDS, SvixSignatureError, verifySvixSignature } from "../../src/lib/email/svix-signature.js";

// STORY-178 AC1 — the Svix scheme (HMAC-SHA256 over `${id}.${timestamp}.${body}`, base64, `v1,` prefix, `whsec_` base64
// secret), verified in-house with node:crypto (owner decision 9: no svix dependency).

// Svix's PUBLISHED test vector (the "Verifying Webhooks Manually" example of docs.svix.com). Not computed by this code.
const VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: "1614265330",
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};
const AT_VECTOR = new Date(1614265330 * 1000);

const verify = (over: Partial<typeof VECTOR> & { now?: Date } = {}) =>
  verifySvixSignature({
    secret: over.secret ?? VECTOR.secret,
    id: over.id ?? VECTOR.id,
    timestamp: over.timestamp ?? VECTOR.timestamp,
    signatureHeader: over.signature ?? VECTOR.signature,
    body: Buffer.from(over.body ?? VECTOR.body),
    now: over.now ?? AT_VECTOR,
  });

function sign(secret: string, id: string, timestamp: string, body: string): string {
  return "v1," + createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
}

describe("STORY-178 AC1 · Svix signature verification", () => {
  it("accepts Svix's published vector", () => {
    expect(() => verify()).not.toThrow();
  });

  it("refuses a body that differs by one byte", () => {
    expect(() => verify({ body: '{"test": 2432232315}' })).toThrow(SvixSignatureError);
  });

  it("refuses a different message id, a different timestamp and a different secret", () => {
    expect(() => verify({ id: "msg_other" })).toThrow(SvixSignatureError);
    expect(() => verify({ timestamp: "1614265331" })).toThrow(SvixSignatureError);
    expect(() => verify({ secret: "whsec_plJ3nmyCDGBKInavdOK15jsl" })).toThrow(SvixSignatureError);
  });

  it("refuses a missing or empty header, and a signature of the wrong length or alphabet", () => {
    expect(() => verify({ signature: "" })).toThrow(SvixSignatureError);
    expect(() => verify({ signature: "v1," })).toThrow(SvixSignatureError);
    expect(() => verify({ signature: "v1,AAAA" })).toThrow(SvixSignatureError);
    expect(() => verify({ signature: "v1,!!!!not base64!!!!" })).toThrow(SvixSignatureError);
    expect(() => verify({ id: "" })).toThrow(SvixSignatureError);
  });

  it("accepts any listed v1 signature (a rotated secret signs twice) and ignores other versions", () => {
    const good = VECTOR.signature;
    expect(() => verify({ signature: `v1,${Buffer.alloc(32).toString("base64")} ${good}` })).not.toThrow();
    expect(() => verify({ signature: `v2,${good.slice(3)}` })).toThrow(SvixSignatureError);
    expect(() => verify({ signature: `v1a,${good.slice(3)}` })).toThrow(SvixSignatureError);
    expect(() => verify({ signature: good.slice(3) })).toThrow(SvixSignatureError);
  });

  it("enforces the tolerance in BOTH directions: a stale and a future timestamp are refused even with a valid signature", () => {
    expect(SVIX_TOLERANCE_SECONDS).toBe(300);
    const at = (seconds: number) => new Date((1614265330 + seconds) * 1000);
    expect(() => verify({ now: at(SVIX_TOLERANCE_SECONDS) })).not.toThrow();
    expect(() => verify({ now: at(-SVIX_TOLERANCE_SECONDS) })).not.toThrow();
    expect(() => verify({ now: at(SVIX_TOLERANCE_SECONDS + 1) })).toThrow(/tolerance/);
    expect(() => verify({ now: at(-SVIX_TOLERANCE_SECONDS - 1) })).toThrow(/tolerance/);
  });

  it("refuses a timestamp that is not a plain integer, before looking at the signature", () => {
    for (const timestamp of ["", "abc", "1614265330.5", "1e9", " 1614265330", "-1", "0x10"]) {
      const body = VECTOR.body;
      const signature = sign(VECTOR.secret, VECTOR.id, timestamp, body);
      expect(() => verify({ timestamp, signature }), JSON.stringify(timestamp)).toThrow(SvixSignatureError);
    }
  });

  it("refuses to run with a secret that is not whsec_ plus base64: it fails closed rather than verify against an empty key", () => {
    for (const secret of ["", "whsec_", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "whsec_!!!"]) {
      expect(() => verify({ secret }), secret).toThrow(SvixSignatureError);
    }
  });

  it("hashes the RAW bytes: a body that is not valid UTF-8 verifies against the signature of those bytes", () => {
    const raw = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    const key = Buffer.from(VECTOR.secret.slice(6), "base64");
    const header = "v1," + createHmac("sha256", key).update(Buffer.concat([Buffer.from(`${VECTOR.id}.${VECTOR.timestamp}.`), raw])).digest("base64");
    expect(() => verifySvixSignature({ secret: VECTOR.secret, id: VECTOR.id, timestamp: VECTOR.timestamp, signatureHeader: header, body: raw, now: AT_VECTOR })).not.toThrow();
  });

  it("the error never carries the secret, the signature or the body", () => {
    try {
      verify({ body: "tampered-body-text" });
      expect.unreachable();
    } catch (error) {
      const text = String((error as Error).message);
      expect(text).not.toContain("tampered-body-text");
      expect(text).not.toContain(VECTOR.secret);
      expect(text).not.toContain(VECTOR.signature.slice(3, 15));
    }
  });
});
