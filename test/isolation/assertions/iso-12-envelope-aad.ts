import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { discoverEncryptedColumns } from "../support/discovery.js";
import { decryptField, encryptField, EnvelopeDecryptError, type EnvelopeAad } from "../../../src/lib/crypto/envelope.js";
import { testDek } from "../../support/test-dek.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-12 / STORY-012 T19 · D-2 — foreign
// ciphertext fails to decrypt, for EVERY *_enc column discovered from the
// schema (never hand-listed). This is a pure lib-level property
// (src/lib/crypto/envelope.ts), exercised here against a real row id from
// each discovered table so the assertion is about something real, not a
// synthetic aad object.
//
// `encryptImpl`/`decryptImpl` default to the real envelope functions — the
// breaker-matrix test (T27) swaps in a deliberately AAD-blind seal+open PAIR
// instead of mutating a database (there is no database-level policy to break
// here; the property under test lives entirely in src/lib/crypto/envelope.ts).
// Both must change together: an AAD-blind decrypt paired with a
// still-AAD-bound encrypt fails GCM's own authentication check before ever
// reaching the foreign-AAD property this assertion exists to test.
export async function assertIso12EnvelopeAad(
  ctx: AssertionContext,
  encryptImpl: typeof encryptField = encryptField,
  decryptImpl: typeof decryptField = decryptField,
): Promise<void> {
  const client = await connectSuperuser(ctx);
  let columns: Awaited<ReturnType<typeof discoverEncryptedColumns>>;
  try {
    columns = await discoverEncryptedColumns(client);
  } finally {
    await client.end();
  }

  const dek = testDek("iso-12-shared-test-dek");
  const dekId = "dek-1";

  for (const { table, column } of columns) {
    const rowIdClient = await connectSuperuser(ctx);
    let rowId: string;
    let workspaceId: string;
    try {
      const result = await rowIdClient.query<{ id: string; workspace_id: string }>(`SELECT id, workspace_id FROM ${table} LIMIT 1`);
      if (result.rowCount === 0) {
        throw new Error(`ISO-12: table ${table} has no rows to test ${column} against`);
      }
      rowId = result.rows[0]!.id;
      workspaceId = result.rows[0]!.workspace_id;
    } finally {
      await rowIdClient.end();
    }

    const genuineAad: EnvelopeAad = { workspaceId, table, column, rowId };
    const sealed = encryptImpl("secret-value", dek, dekId, genuineAad);

    // Sanity: decrypts fine with the genuine AAD (the green half of the property).
    if (decryptImpl(sealed, dek, genuineAad) !== "secret-value") {
      throw new Error(`ISO-12: ${table}.${column} failed to decrypt with its OWN correct AAD`);
    }

    // The property under test: a ciphertext copied to another tenant's row fails.
    const foreignAad: EnvelopeAad = { ...genuineAad, workspaceId: `${workspaceId}-foreign` };
    let rejected = false;
    try {
      decryptImpl(sealed, dek, foreignAad);
    } catch (error) {
      if (error instanceof EnvelopeDecryptError) rejected = true;
      else throw error;
    }
    if (!rejected) {
      throw new Error(`ISO-12: ${table}.${column} decrypted successfully with a FOREIGN workspace_id in the AAD`);
    }

    // The breaker case D-2/T19 names explicitly: an AAD that OMITS
    // workspace_id entirely must fail identically to a foreign one.
    const omittedAad: EnvelopeAad = { ...genuineAad, workspaceId: "" };
    let omittedRejected = false;
    try {
      decryptImpl(sealed, dek, omittedAad);
    } catch (error) {
      if (error instanceof EnvelopeDecryptError) omittedRejected = true;
      else throw error;
    }
    if (!omittedRejected) {
      throw new Error(`ISO-12: ${table}.${column} decrypted successfully with workspace_id OMITTED from the AAD`);
    }
  }
}

/**
 * A deliberately-broken seal+open PAIR that never binds AAD on either side —
 * the breaker for a pure-code property with no database policy to mutate.
 * Both encrypt and decrypt must be AAD-blind together: that way the genuine
 * round-trip still succeeds (so the assertion reaches the foreign-AAD
 * check), but so does decrypting under a FOREIGN workspace_id — which is
 * exactly the missing-additional-data-binding failure ISO-12 exists to catch.
 */
function encryptFieldIgnoringAad(plaintext: string, dek: Buffer, dekId: string, _aad: EnvelopeAad): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  // No setAAD call at all — this is the defect.
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", dekId, iv.toString("base64"), Buffer.concat([ciphertext, tag]).toString("base64")].join(":");
}

function decryptFieldIgnoringAad(field: string, dek: Buffer, _aad: EnvelopeAad): string {
  const parts = field.split(":");
  const iv = Buffer.from(parts[2]!, "base64");
  const combined = Buffer.from(parts[3]!, "base64");
  const ciphertext = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  // No setAAD call at all — this is the defect.
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export const iso12Breaker: Breaker = {
  id: "ISO-12",
  description: "swaps in an AAD-blind seal+open pair (no database policy exists for this pure-code property)",
  apply: NOOP_REVERT,
  revert: NOOP_REVERT,
};

/** Exported for the breaker-matrix test: runs assertIso12EnvelopeAad against the AAD-blind seal+open pair — expected to throw the assertion's own "decrypted successfully with a FOREIGN workspace_id" message. */
export async function assertIso12AgainstAadBlindDecrypt(ctx: AssertionContext): Promise<void> {
  return assertIso12EnvelopeAad(ctx, encryptFieldIgnoringAad, decryptFieldIgnoringAad);
}
