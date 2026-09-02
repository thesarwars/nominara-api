import { customType } from "drizzle-orm/pg-core";

// STORY-122 — the two column types Drizzle 0.45 has no builder for, and this
// schema uses. Hand-authored: src/db/schema/generate.ts emits references to
// them, never definitions of them.

/**
 * `bytea`. Every use in this schema is a digest or a wrapped key — a
 * content hash, an HMAC, a wrapped DEK, a WebAuthn credential id — so the
 * TypeScript type is `Buffer` and never a string. `pg` already returns
 * bytea as a Buffer, so this is the shape the driver hands over, not a
 * conversion.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * `citext`. The case-insensitivity lives in Postgres, not here — an email or
 * a slug compared in TypeScript is compared case-SENSITIVELY, exactly as it
 * would be with `text`. Modelling it as its own type rather than collapsing
 * it to `text` keeps that visible at the call site and keeps the generated
 * schema honest about what the column actually is.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => "citext",
});
