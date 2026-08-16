import { describe, expect, it } from "vitest";
import { assertIso11TamperedJobRejectedPreContext } from "./assertions/iso-11-tampered-job-signature.js";
import { assertIso12EnvelopeAad } from "./assertions/iso-12-envelope-aad.js";
import { getAssertionContext } from "./support/context.js";

describe("ISO-11 · a tampered job payload is rejected BEFORE any set_config call", () => {
  it("holds for a tampered payload, a non-hex signature, and a wrong-length signature", async () => {
    await expect(assertIso11TamperedJobRejectedPreContext()).resolves.toBeUndefined();
  });
});

describe("ISO-12 · foreign ciphertext fails to decrypt, every discovered *_enc column", () => {
  it("holds for every encrypted column discovered from the schema", async () => {
    await expect(assertIso12EnvelopeAad(getAssertionContext())).resolves.toBeUndefined();
  });
});
