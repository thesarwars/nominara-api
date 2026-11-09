import { createDecipheriv } from "node:crypto";

// The inverse of LocalDekProvisioner.provision (STORY-021-E-10): `wrapped_dek` is iv(12) || authTag(16) || ciphertext(32), sealed with
// AES-256-GCM under the configured wrapping key. A raw DEK is held only for the duration of one encrypt/decrypt call and never stored.
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const TAG_END = IV_LENGTH + TAG_LENGTH;

export function unwrapDek(wrappedDek: Buffer, wrappingKey: Buffer): Buffer {
  if (wrappedDek.length <= IV_LENGTH + TAG_LENGTH) throw new Error("dek: wrapped key is too short");
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, wrappedDek.subarray(0, IV_LENGTH));
  decipher.setAuthTag(wrappedDek.subarray(IV_LENGTH, TAG_END));
  return Buffer.concat([decipher.update(wrappedDek.subarray(TAG_END)), decipher.final()]);
}
