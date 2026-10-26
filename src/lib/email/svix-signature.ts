import { createHmac, timingSafeEqual } from "node:crypto";

// STORY-178 AC1 / owner decision 9 — Svix webhook signature verification, in-house with node:crypto (no `svix` dependency).
// Resend signs its webhooks with Svix. The scheme (https://docs.svix.com/receiving/verifying-payloads/how-manual):
//
//   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
//   signature      = base64( HMAC-SHA256( base64decode(secret without "whsec_"), signed content ) )
//   svix-signature = space-separated list of `v1,<signature>` (more than one while a secret is being rotated)
//
// Tested against Svix's published vector (test/unit/svix-signature.spec.ts).
//
// ORDER: the timestamp is checked FIRST and in BOTH directions (a replay of an old delivery, or a far-future one that would
// stay "fresh" forever), then the signature, against EVERY listed v1 signature with a constant-time compare. Every refusal is
// the same SvixSignatureError kind: the message names the check that failed and never carries the secret, the signature or
// any part of the body.

export const SVIX_TOLERANCE_SECONDS = 300;

const SECRET_PREFIX = "whsec_";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const DIGITS = /^[0-9]{1,15}$/u;
const HMAC_SHA256_BYTES = 32;

export class SvixSignatureError extends Error {
  constructor(reason: string) {
    super(`webhook signature verification failed: ${reason}`);
    this.name = "SvixSignatureError";
  }
}

export interface SvixVerifyInput {
  /** The `whsec_...` signing secret. */
  readonly secret: string;
  readonly id: string | undefined;
  readonly timestamp: string | undefined;
  readonly signatureHeader: string | undefined;
  /** The bytes Svix signed: the raw request body, before any parsing. */
  readonly body: Buffer;
  readonly now?: Date;
}

function keyOf(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) throw new SvixSignatureError("the signing secret is not configured in the whsec_ form");
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (encoded === "" || !BASE64.test(encoded)) throw new SvixSignatureError("the signing secret is not configured in the whsec_ form");
  const key = Buffer.from(encoded, "base64");
  if (key.length === 0) throw new SvixSignatureError("the signing secret is not configured in the whsec_ form");
  return key;
}

/** Throws SvixSignatureError unless the request is a fresh, correctly signed delivery. Returns nothing: there is no "partly valid". */
export function verifySvixSignature(input: SvixVerifyInput): void {
  const key = keyOf(input.secret);
  const { id, timestamp, signatureHeader } = input;
  if (id === undefined || id === "" || timestamp === undefined || signatureHeader === undefined || signatureHeader === "") {
    throw new SvixSignatureError("a required header is missing");
  }
  if (!DIGITS.test(timestamp)) throw new SvixSignatureError("the timestamp is malformed");
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > SVIX_TOLERANCE_SECONDS) {
    throw new SvixSignatureError(`the timestamp is outside the ${String(SVIX_TOLERANCE_SECONDS)} second tolerance`);
  }

  const expected = createHmac("sha256", key).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), input.body])).digest();
  let matched = false;
  for (const entry of signatureHeader.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma === -1 || entry.slice(0, comma) !== "v1") continue;
    const encoded = entry.slice(comma + 1);
    if (!BASE64.test(encoded)) continue;
    const candidate = Buffer.from(encoded, "base64");
    // Every listed signature is compared (no early exit), and only equal-length buffers reach timingSafeEqual.
    if (candidate.length === HMAC_SHA256_BYTES && timingSafeEqual(candidate, expected)) matched = true;
  }
  if (!matched) throw new SvixSignatureError("no signature matches");
}
