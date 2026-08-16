import { createHash } from "node:crypto";

// STORY-012 D-2 fix pass — a plain SHA-256 hash is NOT a KDF and must never
// ship alongside the real production crypto primitives in
// src/lib/crypto/envelope.ts. Test-only: a local, in-memory DEK, deterministic
// given `seed` so tests are reproducible. Never used by production code.
export function testDek(seed: string): Buffer {
  return createHash("sha256").update(seed).digest();
}
