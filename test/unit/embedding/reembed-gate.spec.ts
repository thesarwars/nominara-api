import { describe, expect, it } from "vitest";
import { assertReembedEnabled, ReembedDisabledError } from "../../../src/lib/embedding/reembed.js";

// STORY-186 / owner decision 104(b) - the re-embed starts only from an operator command, off by default behind config.

describe("STORY-186 - EMBED_REEMBED_ENABLED gate", () => {
  it("is off by default: an unset flag refuses the command, naming the variable", () => {
    expect(() => assertReembedEnabled({})).toThrow(ReembedDisabledError);
    expect(() => assertReembedEnabled({})).toThrow(/EMBED_REEMBED_ENABLED/);
  });

  it("only the literal \"true\" enables it", () => {
    expect(() => assertReembedEnabled({ EMBED_REEMBED_ENABLED: "true" })).not.toThrow();
    for (const value of ["1", "TRUE", "yes", "false", ""]) {
      expect(() => assertReembedEnabled({ EMBED_REEMBED_ENABLED: value as "true" }), value).toThrow(ReembedDisabledError);
    }
  });
});
