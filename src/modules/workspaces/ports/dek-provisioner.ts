// STORY-021-E-10 — no story in the backlog owns a KMS integration
// (src/lib/crypto/envelope.ts documents itself as deliberately not
// KMS-backed). This port is the seam a future KMS story swaps the adapter
// behind, without touching WorkspacesService.create — the exact
// port-plus-local-adapter precedent set by STORY-020-E-3/E-4
// (src/modules/audit/ports/export-sink.ts).

export const DEK_PROVISIONER = Symbol("DEK_PROVISIONER");

export interface WrappedDek {
  /** workspace_keys.dek_id — an opaque identifier for this DEK, not the key material itself. */
  readonly dekId: string;
  /** workspace_keys.wrapped_dek (bytea) — the DEK, encrypted under the wrapping key. Never the raw DEK. */
  readonly wrappedDek: Buffer;
  /** workspace_keys.kms_key_arn — recorded verbatim. */
  readonly kmsKeyArn: string;
}

export interface DekProvisioner {
  /** Generates and wraps a fresh DEK for a newly created workspace. Pure in-process work — no network call, per the no-expensive-work-on-the-request-path rule. */
  provision(workspaceId: string): Promise<WrappedDek>;
}
