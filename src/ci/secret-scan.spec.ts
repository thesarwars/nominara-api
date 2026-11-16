import { describe, expect, it } from "vitest";
import { scanTracked, scanText, type Finding } from "./secret-scan.js";

// STORY-110 AC14 (standing control: secrets scanning blocks the build). Test scenario 17: "Introduce a secret ... each
// blocks at its documented severity" - here, any finding of a known credential shape blocks (exit 1).
// The fixtures are assembled at run time so this file does not itself contain a credential-shaped literal.
const join = (...parts: string[]): string => parts.join("");
const FIXTURES: Readonly<Record<string, string>> = {
  "aws-access-key-id": join("AK", "IA", "ABCDEFGHIJKLMNOP"),
  "private-key-block": join("-----BEGIN ", "RSA PRIVATE KEY", "-----"),
  "stripe-live-key": join("sk_", "live_", "4eC39HqLyjWDarjtT1zdp7dc"),
  "stripe-webhook-secret": join("wh", "sec_", "4eC39HqLyjWDarjtT1zdp7dc"),
  "github-token": join("gh", "p_", "a".repeat(36)),
  "slack-token": join("xo", "xb-", "1234567890-abcdefghijkl"),
  "google-api-key": join("AI", "za", "SyA1234567890abcdefghijklmnopqrstuv"),
  "url-with-credentials": join("postgres://", "app", ":", "Pr0dPassw0rd", "@", "db.internal.example.com:5432/x"),
};

describe("STORY-110 AC14 - the secrets scan", () => {
  it.each(Object.entries(FIXTURES))("finds a %s and names the rule, the file and the line - never the value", (rule, value) => {
    const findings = scanText("src/x.ts", `const a = 1;\nconst k = "${value}";\n`);
    expect(findings.map((f: Finding) => f.rule)).toEqual([rule]);
    expect(findings[0]).toMatchObject({ path: "src/x.ts", line: 2 });
    expect(JSON.stringify(findings)).not.toContain(value);
  });

  it("a local development URL and the documented placeholders are not findings", () => {
    const text = [
      'DATABASE_URL="postgres://nominara:nominara@localhost:5432/nominara"',
      'const u = "postgres://fake:fake@localhost:5432/fake";',
      'const v = "postgres://user:password@127.0.0.1/db";',
      "const w = `postgres://${user}:${pass}@${host}/db`;",
    ].join("\n");
    expect(scanText("a.ts", text)).toEqual([]);
  });

  it("a hostile URL fixture in a test file is not a finding, but a fixed-shape credential in a test file still is", () => {
    const url = FIXTURES["url-with-credentials"]!;
    expect(scanText("test/unit/x.spec.ts", `const u = "${url}";`)).toEqual([]);
    expect(scanText("src/y.spec.ts", `const u = "${url}";`)).toEqual([]);
    // A made-up webhook secret in a billing spec is a fixture; the same shape in production source is not.
    const whsec = FIXTURES["stripe-webhook-secret"]!;
    expect(scanText("src/lib/billing/x.spec.ts", `const s = "${whsec}";`)).toEqual([]);
    expect(scanText("src/lib/billing/x.ts", `const s = "${whsec}";`).map((f) => f.rule)).toEqual(["stripe-webhook-secret"]);
    expect(scanText("test/unit/x.spec.ts", `const k = "${FIXTURES["stripe-live-key"]!}";`).map((f) => f.rule)).toEqual(["stripe-live-key"]);
  });

  it("an explicit allow marker on the line suppresses that line only", () => {
    const value = FIXTURES["stripe-live-key"]!;
    const text = `const a = "${value}"; // nominara-secret-scan:allow documented example\nconst b = "${value}";\n`;
    expect(scanText("a.ts", text).map((f) => f.line)).toEqual([2]);
  });

  it("an empty file and a file with no secrets produce nothing", () => {
    expect(scanText("a.ts", "")).toEqual([]);
    expect(scanText("a.ts", "const a = 'hello';\n")).toEqual([]);
  });

  it("scans the tracked tree and finds nothing in the repository as committed (the gate is green on arrival)", async () => {
    const findings = await scanTracked();
    expect(findings, `secrets found (paths and rules only): ${JSON.stringify(findings)}`).toEqual([]);
  }, 60_000);

  it("a tracked .env file (other than .env.example) is itself a finding", async () => {
    const { trackedEnvFindings } = await import("./secret-scan.js");
    expect(trackedEnvFindings([".env", "api/.env.local", ".env.example", "src/env.ts"]).map((f) => f.path)).toEqual([".env", "api/.env.local"]);
  });
});
