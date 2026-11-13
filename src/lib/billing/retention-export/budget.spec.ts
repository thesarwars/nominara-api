import { describe, expect, it } from "vitest";
import { ByteBudget, RETENTION_EXPORT_MAX_BYTES } from "./build.js";
import { ZipLimitError } from "./zip.js";

// STORY-185 fix round (audit, major 3) - the build's byte budget.
describe("STORY-185 · ByteBudget", () => {
  it("the default is 1 GiB, a named constant marked provisional for the owner", () => {
    expect(RETENTION_EXPORT_MAX_BYTES).toBe(1024 ** 3);
  });
  it("accepts exactly the cap and refuses the first byte over it, with the typed error", () => {
    const b = new ByteBudget(10);
    b.add(4);
    b.add(6);
    expect(b.used).toBe(10);
    expect(() => b.add(1)).toThrow(ZipLimitError);
  });
  it("zero bytes is fine at a zero cap; a negative or fractional cap is a programming error", () => {
    expect(() => new ByteBudget(0).add(0)).not.toThrow();
    expect(() => new ByteBudget(-1)).toThrow();
    expect(() => new ByteBudget(1.5)).toThrow();
  });
});
