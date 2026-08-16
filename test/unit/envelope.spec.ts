import { describe, expect, it } from "vitest";
import { decryptField, encryptField, EnvelopeDecryptError } from "../../src/lib/crypto/envelope.js";
import { testDek } from "../support/test-dek.js";

describe("ISO-12 · src/lib/crypto/envelope.ts", () => {
  const dek = testDek("unit-test-dek");
  const aad = { workspaceId: "ws-a", table: "gsc_connections", column: "credentials_enc", rowId: "row-1" };

  it("round-trips plaintext through the v1:{dek_id}:{iv}:{ct} format", () => {
    const field = encryptField("super-secret", dek, "dek-1", aad);
    expect(field.split(":")).toHaveLength(4);
    expect(field.startsWith("v1:dek-1:")).toBe(true);
    expect(decryptField(field, dek, aad)).toBe("super-secret");
  });

  it("fails to decrypt when the AAD's workspace_id differs (the ISO-12 property)", () => {
    const field = encryptField("super-secret", dek, "dek-1", aad);
    expect(() => decryptField(field, dek, { ...aad, workspaceId: "ws-b" })).toThrow(EnvelopeDecryptError);
  });

  it("fails to decrypt when the AAD omits workspace_id entirely (the ISO-12 breaker shape)", () => {
    const field = encryptField("super-secret", dek, "dek-1", aad);
    expect(() => decryptField(field, dek, { ...aad, workspaceId: "" })).toThrow(EnvelopeDecryptError);
  });

  it("fails to decrypt with the wrong DEK", () => {
    const field = encryptField("super-secret", dek, "dek-1", aad);
    expect(() => decryptField(field, testDek("a different dek"), aad)).toThrow(EnvelopeDecryptError);
  });

  it("rejects a malformed field format", () => {
    expect(() => decryptField("not-the-right-shape", dek, aad)).toThrow(EnvelopeDecryptError);
  });
});
