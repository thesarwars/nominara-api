import { createCipheriv, randomBytes } from "node:crypto";
import { uuidV7 } from "../../../lib/ids/uuidv7.js";
import type { DekProvisioner, WrappedDek } from "../ports/dek-provisioner.js";

// STORY-021-E-10 — local-filesystem-config approximation of a KMS-wrapped
// DEK, same disclosed-gap posture as STORY-020's LocalDirExportSink: this is
// NOT equivalent to real envelope encryption under a KMS CMK — the wrapping
// key lives in configuration (WORKSPACE_DEK_WRAPPING_KEY), not a managed
// key service. node:crypto only, no new dependency. wrapped_dek stores
// iv || authTag || ciphertext concatenated, so unwrap is self-contained
// (no separate column needed for the IV/tag).

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const DEK_LENGTH = 32;

export class LocalDekProvisioner implements DekProvisioner {
  constructor(
    private readonly wrappingKey: Buffer,
    private readonly kmsKeyArn: string,
  ) {
    if (wrappingKey.length !== DEK_LENGTH) {
      throw new Error("LocalDekProvisioner: wrapping key must be exactly 32 bytes");
    }
  }

  async provision(_workspaceId: string): Promise<WrappedDek> {
    const dek = randomBytes(DEK_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.wrappingKey, iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      dekId: uuidV7(),
      wrappedDek: Buffer.concat([iv, authTag, ciphertext]),
      kmsKeyArn: this.kmsKeyArn,
    };
  }
}
