import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanText, scanTree, testFiles, type Finding } from "../support/valkey-url-scan.js";

// STORY-174 AC2 — no test file may hard-code a developer's Valkey/redis.
//
// A hard-coded loopback URL on the development ports is the docker-compose queue
// instance or the Homebrew redis: on a developer machine such a spec connects to
// the developer's own service. The scanner's default is REPORT. The allow-list below
// is the ONLY exemption mechanism: each entry names a file, the exact matched
// text that is permitted in it, and why. No pattern in the scanner is ever
// widened to make a finding go away.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(REPO, "test/unit/fixtures/valkey-guard");

interface Allowed {
  readonly file: string;
  readonly tokens: readonly string[];
  readonly reason: string;
}

const ALLOWED: readonly Allowed[] = [
  {
    file: "test/support/test-valkey.ts",
    tokens: ["redis://127.0.0.1:1", "6379", "6380", "56379"],
    reason:
      "The harness module itself: it must NAME the developer ports to refuse them, and defines the one dead-address " +
      "literal (loopback port 1 refuses every connection and is no service) that other specs import instead of typing.",
  },
  {
    file: "test/support/valkey-fixture.ts",
    tokens: ["6379"],
    reason:
      "The CONTAINER-side port inside a throwaway testcontainers Valkey; the host side is an ephemeral mapped port " +
      "(getMappedPort), so nothing here can address a developer service.",
  },
  {
    file: "src/lib/net/guarded-fetch.test.ts",
    tokens: ["6379"],
    reason:
      "An SSRF test: 6379 appears as a BLOCKED destination port on example.com (guardedFetch must refuse it). " +
      "It is not a Valkey connection and is never dialled.",
  },
  {
    file: "test/unit/test-valkey-env.spec.ts",
    tokens: ["6379", "6380", "56379", "redis://localhost"],
    reason: "Asserts the harness refuses each developer port; the values are inputs to pure predicates, never dialled.",
  },
  {
    file: "test/unit/test-valkey-guard.spec.ts",
    tokens: ["6379", "6380", "56379", "redis://127.0.0.1:1", "redis://localhost"],
    reason:
      "This file's own allow-list names the developer ports it permits elsewhere. The bad SAMPLES live in fixtures/valkey-guard/*.txt, " +
      "which the scanner never reads, so no sample URL appears here.",
  },
  {
    file: "test/support/valkey-url-scan.ts",
    tokens: [],
    reason: "The scanner. Listed only so a future literal added to it is judged by the same rule; it currently needs none.",
  },
];

function unallowed(findings: readonly Finding[]): Finding[] {
  return findings.filter((f) => {
    const entry = ALLOWED.find((a) => a.file === f.file);
    return entry === undefined || !entry.tokens.includes(f.match);
  });
}

function describeFindings(findings: readonly Finding[]): string {
  return findings.map((f) => `${f.file}:${String(f.line)} [${f.rule}] ${f.match}`).join("\n");
}

function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "story-174-scan-"));
  for (const dir of ["test", "src", "contracts"]) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

describe("STORY-174 AC2 · no test file hard-codes a developer's Valkey", () => {
  it("AC2 · the real tree has no hard-coded localhost/loopback Valkey URL, developer port, or literal connection variable", () => {
    const found = unallowed(scanTree(REPO));
    expect(describeFindings(found)).toBe("");
  });

  it("AC2 · the scan really covers test/, src/ and contracts/ spec files and the vitest configs", () => {
    const files = testFiles(REPO);
    expect(files).toContain("test/unit/env.spec.ts");
    expect(files).toContain("test/support/fake-env.ts");
    expect(files).toContain("src/main.spec.ts");
    expect(files.some((f) => f.startsWith("contracts/") && f.endsWith(".test.ts"))).toBe(true);
    expect(files).toContain("vitest.integration.config.ts");
    expect(files.length).toBeGreaterThan(150);
  });

  it("AC2 · every allow-list entry has a written reason, names a real file, and is still needed (no stale entries)", () => {
    const all = scanTree(REPO);
    for (const entry of ALLOWED) {
      expect(entry.reason.length, `${entry.file} needs a reason`).toBeGreaterThanOrEqual(40);
      expect(testFiles(REPO), `${entry.file} is not a scanned file`).toContain(entry.file);
      const used = new Set(all.filter((f) => f.file === entry.file).map((f) => f.match));
      for (const token of entry.tokens) {
        expect(used.has(token), `${entry.file} no longer contains ${token}: drop it from the allow-list`).toBe(true);
      }
      // An entry may permit only what it lists: nothing else in that file escapes.
      expect(describeFindings(unallowed(all.filter((f) => f.file === entry.file)))).toBe("");
    }
  });

  describe("AC2 · every bad shape is reported, every good shape is not", () => {
    for (const name of readdirSync(FIXTURES).sort()) {
      const snippet = readFileSync(join(FIXTURES, name), "utf8");
      if (name.startsWith("bad-")) {
        it(`AC2 · reports ${name}`, () => {
          expect(scanText("test/unit/x.spec.ts", snippet).length).toBeGreaterThan(0);
        });
      } else {
        it(`AC2 · does not report ${name}`, () => {
          expect(describeFindings(scanText("test/unit/x.spec.ts", snippet))).toBe("");
        });
      }
    }
  });

  it("AC2 · mutation — the same walk that passes the real tree turns red when a hard-coded URL is added to a scratch COPY of a real spec", () => {
    const root = scratchRepo();
    try {
      mkdirSync(join(root, "test/unit"), { recursive: true });
      cpSync(join(REPO, "test/unit/email-otp-send-deferral.spec.ts"), join(root, "test/unit/email-otp-send-deferral.spec.ts"));
      cpSync(join(REPO, "test/support/test-valkey.ts"), join(root, "test/support/test-valkey.ts"), { recursive: true });
      expect(scanTree(root)).toEqual(scanTree(root)); // deterministic
      const clean = unallowed(scanTree(root));
      expect(describeFindings(clean)).toBe("");

      const copy = join(root, "test/unit/email-otp-send-deferral.spec.ts");
      const original = readFileSync(copy, "utf8");
      // The mutation: the two shapes this story removed, appended to the copy.
      const mutation =
        readFileSync(join(FIXTURES, "bad-url-localhost.txt"), "utf8") +
        readFileSync(join(FIXTURES, "bad-env-literal-assignment.txt"), "utf8");
      writeFileSync(copy, original + "\n" + mutation);

      const dirty = unallowed(scanTree(root));
      expect(dirty.map((f) => f.rule).sort()).toEqual(["developer-port", "env-literal", "valkey-url"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("AC2 · mutation — a spec under src/ and a *.test.ts under contracts/ are covered by the walk", () => {
    const root = scratchRepo();
    try {
      mkdirSync(join(root, "contracts/a"), { recursive: true });
      const bad = readFileSync(join(FIXTURES, "bad-url-loopback-ip.txt"), "utf8");
      writeFileSync(join(root, "src/a.spec.ts"), bad);
      writeFileSync(join(root, "contracts/a/b.test.ts"), bad);
      writeFileSync(join(root, "src/not-a-test.ts"), bad); // app code: out of scope here
      expect(scanTree(root).map((f) => f.file).sort()).toEqual(["contracts/a/b.test.ts", "src/a.spec.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
