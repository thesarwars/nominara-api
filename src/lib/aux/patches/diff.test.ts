import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./diff.js";

describe("STORY-053 AC1 · the unified diff a patch states", () => {
  it("is empty for identical text", () => {
    expect(unifiedDiff("robots.txt", "a\nb\n", "a\nb\n")).toBe("");
  });

  it("states an append with its hunk header", () => {
    expect(unifiedDiff("robots.txt", "a\nb\n", "a\nb\nc\n")).toBe("--- a/robots.txt\n+++ b/robots.txt\n@@ -1,2 +1,3 @@\n a\n b\n+c\n");
  });

  it("states a deletion and a replacement", () => {
    expect(unifiedDiff("f", "a\nb\nc\n", "a\nc\n")).toBe("--- a/f\n+++ b/f\n@@ -1,3 +1,2 @@\n a\n-b\n c\n");
    expect(unifiedDiff("f", "a\nb\n", "a\nx\n")).toBe("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+x\n");
  });

  it("states a creation from nothing (the file did not exist)", () => {
    expect(unifiedDiff("llms.txt", "", "# A\n")).toBe("--- a/llms.txt\n+++ b/llms.txt\n@@ -0,0 +1,1 @@\n+# A\n");
  });

  it("limits context to three lines either side of a change", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") + "\n";
    const after = before.replace("l10\n", "L10\n");
    const out = unifiedDiff("f", before, after);
    expect(out).toContain("@@ -8,7 +8,7 @@");
    expect(out).not.toContain(" l0\n");
  });

  it("refuses to diff an enormous input rather than spend quadratic time on it", () => {
    const big = Array.from({ length: 5001 }, (_, i) => `l${i}`).join("\n");
    expect(unifiedDiff("f", big, `${big}\nx`)).toBeNull();
  });
});
