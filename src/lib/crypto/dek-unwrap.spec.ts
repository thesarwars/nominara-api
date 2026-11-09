import { describe, expect, it } from "vitest";
import { LocalDekProvisioner } from "../../modules/workspaces/adapters/local-dek-provisioner.js";
import { decryptField, encryptField } from "./envelope.js";
import { unwrapDek } from "./dek-unwrap.js";

const KEY = Buffer.alloc(32, 7);
const AAD = { workspaceId: "w", table: "attribution_configs", column: "ga4_credentials_enc", rowId: "r" };

describe("STORY-113 - unwrapping a provisioned DEK", () => {
  it("round-trips: a field sealed under the unwrapped DEK opens under it, and a wrong wrapping key refuses", async () => {
    const wrapped = await new LocalDekProvisioner(KEY, "local:dev").provision("w");
    const dek = unwrapDek(wrapped.wrappedDek, KEY);
    expect(dek.length).toBe(32);
    expect(decryptField(encryptField("secret", dek, wrapped.dekId, AAD), dek, AAD)).toBe("secret");
    expect(() => unwrapDek(wrapped.wrappedDek, Buffer.alloc(32, 8))).toThrow();
    expect(() => unwrapDek(Buffer.alloc(10), KEY)).toThrow();
  });
});
