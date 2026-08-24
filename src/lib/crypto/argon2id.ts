import { Algorithm, hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

// STORY-016 — dangerous area precedent (credit-ledger-grade hashing choice
// for a short-lived numeric code, per the story's Implementation decisions:
// "password-grade hashing... the code space is small, so a database
// disclosure with fast hashes would be trivially reversible in bulk").
// security-and-tenancy.md §8 pins m=64MiB, t=3, p=1 for Argon2id; confirmed
// against @node-rs/argon2@2.1.0's actual published API (hash/verify take
// `memoryCost` in KiB, `timeCost` iterations, `parallelism` threads — not
// node-argon2's `memoryCost`-as-log2 convention).

const ARGON2ID_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536, // 64 MiB, in KiB
  timeCost: 3,
  parallelism: 1,
} as const;

/** Argon2id-hashes `plaintext`, returning the self-describing `$argon2id$...` encoded string. */
export function hash(plaintext: string): Promise<string> {
  return argon2Hash(plaintext, ARGON2ID_OPTIONS);
}

/** Verifies `plaintext` against a previously-encoded Argon2id hash. */
export function verify(plaintext: string, encodedHash: string): Promise<boolean> {
  return argon2Verify(encodedHash, plaintext);
}

// A fixed, hardcoded dummy hash (a real Argon2id encoding of an arbitrary
// fixed string, generated once offline — never a hash of anything
// sensitive, never persisted). verifyDecoy() always verifies against this
// so the unknown-address request path (Implementation decisions, AC
// "identical response and duration") pays the exact same Argon2id cost as
// the known-address path, closing the timing side channel.
const DECOY_ENCODED_HASH = "$argon2id$v=19$m=65536,t=3,p=1$OYKR0Q2Ms5jWhsQpSLTsPA$gZsQd1XGgZffZtxiDibptgS+A1/smY9nLIfDXrIT+Fk";

/**
 * Always resolves `false`, but performs a REAL, full-cost Argon2id verify
 * against a fixed dummy hash first — never a no-op — so its cost is
 * indistinguishable from a genuine verify() call.
 */
export async function verifyDecoy(plaintext: string): Promise<false> {
  await argon2Verify(DECOY_ENCODED_HASH, plaintext);
  return false;
}
