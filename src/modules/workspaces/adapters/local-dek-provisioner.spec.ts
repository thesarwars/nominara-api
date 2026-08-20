import { describe, expect, it } from "vitest";
import { LocalDekProvisioner } from "./local-dek-provisioner.js";

const WRAPPING_KEY = Buffer.alloc(32, 9);

describe("STORY-021-E-10 · LocalDekProvisioner", () => {
  it("rejects a wrapping key that is not exactly 32 bytes", () => {
    expect(() => new LocalDekProvisioner(Buffer.alloc(16), "local:dev")).toThrow(/32 bytes/);
  });

  it("provisions a wrapped DEK carrying the configured kms_key_arn verbatim", async () => {
    const provisioner = new LocalDekProvisioner(WRAPPING_KEY, "local:dev");
    const result = await provisioner.provision("ws-1");
    expect(result.kmsKeyArn).toBe("local:dev");
    expect(Buffer.isBuffer(result.wrappedDek)).toBe(true);
    // iv(12) + authTag(16) + ciphertext(32, since the DEK itself is 32 bytes and GCM is a stream cipher)
    expect(result.wrappedDek.length).toBe(12 + 16 + 32);
  });

  it("every call produces a distinct dekId and a distinct wrapped ciphertext, even for the same workspace", async () => {
    const provisioner = new LocalDekProvisioner(WRAPPING_KEY, "local:dev");
    const first = await provisioner.provision("ws-1");
    const second = await provisioner.provision("ws-1");
    expect(first.dekId).not.toBe(second.dekId);
    expect(first.wrappedDek.equals(second.wrappedDek)).toBe(false);
  });

  it("never returns the raw DEK material unwrapped anywhere in the result", async () => {
    const provisioner = new LocalDekProvisioner(WRAPPING_KEY, "local:dev");
    const result = await provisioner.provision("ws-1");
    expect(Object.keys(result).sort()).toEqual(["dekId", "kmsKeyArn", "wrappedDek"]);
  });
});
