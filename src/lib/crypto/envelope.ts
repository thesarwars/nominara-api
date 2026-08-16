import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// STORY-012 D-2 — security-and-tenancy.md §8's envelope-encryption field
// format, minimal and NOT KMS-backed (a local test-only DEK is passed in by
// the caller). AES-256-GCM. AAD binds workspace_id|table|column|row_id, so a
// ciphertext copied to another row/tenant fails to decrypt (ISO-12) — this is
// the property this file exists to make testable, not a production KMS
// integration (that is a future story's job).

export const ENVELOPE_FORMAT_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface EnvelopeAad {
  readonly workspaceId: string;
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
}

function serializeAad(aad: EnvelopeAad): Buffer {
  return Buffer.from(`${aad.workspaceId}|${aad.table}|${aad.column}|${aad.rowId}`, "utf8");
}

/** Encrypts `plaintext`, returning the `v1:{dek_id}:{iv}:{ct}` field format verbatim from security-and-tenancy.md §8. */
export function encryptField(plaintext: string, dek: Buffer, dekId: string, aad: EnvelopeAad): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, dek, iv);
  cipher.setAAD(serializeAad(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_FORMAT_VERSION, dekId, iv.toString("base64"), Buffer.concat([ciphertext, tag]).toString("base64")].join(
    ":",
  );
}

export class EnvelopeDecryptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EnvelopeDecryptError";
  }
}

/**
 * Decrypts a `v1:{dek_id}:{iv}:{ct}` field. Throws EnvelopeDecryptError when
 * the format is malformed, the DEK is wrong, or — the property ISO-12 tests —
 * `aad` does not match what the ciphertext was originally sealed with (a
 * different workspace_id, table, column, or row_id all change the AAD and
 * therefore fail GCM's authentication tag check).
 */
export function decryptField(field: string, dek: Buffer, aad: EnvelopeAad): string {
  const parts = field.split(":");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_FORMAT_VERSION) {
    throw new EnvelopeDecryptError(`envelope: unrecognized field format (expected ${ENVELOPE_FORMAT_VERSION}:{dek_id}:{iv}:{ct})`);
  }
  const [, , ivB64, ctB64] = parts;
  const iv = Buffer.from(ivB64!, "base64");
  const combined = Buffer.from(ctB64!, "base64");
  if (combined.length < AUTH_TAG_LENGTH) {
    throw new EnvelopeDecryptError("envelope: ciphertext shorter than the auth tag");
  }
  const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
  const tag = combined.subarray(combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, dek, iv);
  decipher.setAAD(serializeAad(aad));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new EnvelopeDecryptError("envelope: authentication failed (wrong DEK or AAD — tampered or foreign ciphertext)", {
      cause: error,
    });
  }
}
