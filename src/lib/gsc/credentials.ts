import type { ClientBase } from "pg";
import { loadEnv } from "../../config/env.js";
import { decryptField, encryptField, type EnvelopeAad } from "../crypto/envelope.js";
import { unwrapDek } from "../crypto/dek-unwrap.js";

// STORY-115 C4 - the Search Console credentials, envelope-encrypted under the workspace's DEK and bound by AAD to this workspace, table,
// column and row, so a ciphertext copied to another connection or tenant does not open. Two columns hold secrets: `credentials_enc`
// (the access token) and `refresh_enc` (the refresh token). Nothing here returns a plaintext to a caller that will serialise it: the
// callers are the callback (sealing what Google just granted) and the sync job (opening it to call Google, in memory only).
//
// Reads and writes are database-only; no network call (ADR-0003). Every statement carries the workspace predicate.

export type GscSecretColumn = "credentials_enc" | "refresh_enc";

export interface GscDek {
  readonly dekId: string;
  readonly key: Buffer;
}

const wrappingKey = (): Buffer => Buffer.from(loadEnv().WORKSPACE_DEK_WRAPPING_KEY, "base64");

const aadFor = (workspaceId: string, connectionId: string, column: GscSecretColumn): EnvelopeAad => ({ workspaceId, table: "gsc_connections", column, rowId: connectionId });

/** The workspace's active DEK. Every workspace is provisioned one at creation, so its absence is a broken invariant: fail closed. */
export async function activeDek(tx: ClientBase, workspaceId: string): Promise<GscDek> {
  const found = await tx.query<{ dek_id: string; wrapped_dek: Buffer }>(
    "SELECT dek_id, wrapped_dek FROM workspace_keys WHERE workspace_id = $1 AND status = 'active' ORDER BY activated_at DESC LIMIT 1",
    [workspaceId],
  );
  const row = found.rows[0];
  if (row === undefined) throw new Error("gsc: the workspace has no active data-encryption key");
  return { dekId: row.dek_id, key: unwrapDek(row.wrapped_dek, wrappingKey()) };
}

/** The DEK a stored field was sealed under (a rotated key still opens what it sealed). */
export async function dekById(tx: ClientBase, workspaceId: string, dekId: string): Promise<GscDek> {
  const found = await tx.query<{ wrapped_dek: Buffer }>("SELECT wrapped_dek FROM workspace_keys WHERE workspace_id = $1 AND dek_id = $2", [workspaceId, dekId]);
  const row = found.rows[0];
  if (row === undefined) throw new Error("gsc: the data-encryption key for this credential is not available");
  return { dekId, key: unwrapDek(row.wrapped_dek, wrappingKey()) };
}

export function sealSecret(dek: GscDek, workspaceId: string, connectionId: string, column: GscSecretColumn, plaintext: string): string {
  const aad = aadFor(workspaceId, connectionId, column);
  const sealed = encryptField(plaintext, dek.key, dek.dekId, aad);
  // A seal that cannot be opened is worse than no seal: prove the round trip before the row is written.
  if (decryptField(sealed, dek.key, aad) !== plaintext) throw new Error("gsc: credential seal failed its round trip");
  return sealed;
}

export function openSecret(dek: GscDek, workspaceId: string, connectionId: string, column: GscSecretColumn, sealed: string): string {
  return decryptField(sealed, dek.key, aadFor(workspaceId, connectionId, column));
}
