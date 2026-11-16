import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// STORY-110 AC14 - the secrets-scanning gate (`pnpm scan:secrets`). Secrets scanning is a standing control that blocks the
// build; no scanner is installed offline and a third-party action is a dependency (gates.yml supply-chain note), so this
// is a small in-repo scan of every TRACKED file for credential SHAPES that have a fixed, recognisable form. It is the
// narrow, high-precision half: a shape either is or is not a credential, so a hit always blocks (exit 1) and there is no
// severity ladder to tune. The entropy detector in src/lib/crypto/redact.ts is deliberately NOT reused - on source text
// it would flag every hash and id literal, and a gate that cries wolf gets deleted.
//
// A finding names the rule, the file and the line. NEVER the matched text: this output lands in CI logs.
// A line carrying `nominara-secret-scan:allow` is skipped (for a documented example); the marker is visible in review.

export interface Finding {
  readonly rule: string;
  readonly path: string;
  readonly line: number;
}

const RULES: ReadonlyArray<{ readonly rule: string; readonly pattern: RegExp; readonly skipInTests?: true }> = [
  { rule: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { rule: "private-key-block", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/u },
  { rule: "stripe-live-key", pattern: /\b[sr]k_live_[0-9A-Za-z]{16,}/u },
  // A test-mode webhook secret has the same shape as a live one, and the billing specs sign with made-up ones. In a test file
  // that shape proves nothing; in anything else it blocks.
  { rule: "stripe-webhook-secret", pattern: /\bwhsec_[0-9A-Za-z]{16,}/u, skipInTests: true },
  { rule: "github-token", pattern: /\bgh[pousr]_[0-9A-Za-z]{36,}/u },
  { rule: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}/u },
  { rule: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
];
// A credential embedded in a URL (scheme, user, password, host). Local development hosts and template placeholders are not.
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`$]+:([^\s@'"`/]+)@([^\s/:'"`]+)/giu;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal", "postgres", "pgbouncer", "valkey", "redis"]);
// Test files hold deliberately hostile URLs (a URL with a password, as an SSRF or log-redaction input). Every other
// fixed-shape rule still applies to them - a real provider key in a test is exactly the leak this gate exists for.
const TEST_FILE = /(?:^|\/)test\/|\.(?:spec|test)\.[cm]?[jt]sx?$/u;
const ALLOW_MARKER = "nominara-secret-scan:allow";

export function scanText(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.includes(ALLOW_MARKER)) continue;
    for (const { rule, pattern, skipInTests } of RULES) {
      if (skipInTests === true && TEST_FILE.test(path)) continue;
      if (pattern.test(line)) findings.push({ rule, path, line: index + 1 });
    }
    for (const match of TEST_FILE.test(path) ? [] : line.matchAll(URL_CREDENTIALS)) {
      const host = match[2]!.toLowerCase();
      if (!LOCAL_HOSTS.has(host) && !match[1]!.includes("{") && !host.includes("{")) {
        findings.push({ rule: "url-with-credentials", path, line: index + 1 });
      }
    }
  }
  return findings;
}

/** A tracked `.env` (anything but a `.env.example`) is a finding on its own: those files exist to hold secrets. */
export function trackedEnvFindings(paths: readonly string[]): Finding[] {
  return paths
    .filter((path) => /(?:^|\/)\.env(?:\.[^/]+)?$/u.test(path) && !/\.env\.example$/u.test(path))
    .map((path) => ({ rule: "tracked-env-file", path, line: 0 }));
}

const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|zip|gz|lockb)$/iu;
const MAX_BYTES = 2 * 1024 * 1024;

export async function scanTracked(root: string = fileURLToPath(new URL("../../", import.meta.url))): Promise<Finding[]> {
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter((path) => path !== "");
  const findings = trackedEnvFindings(paths);
  for (const path of paths) {
    if (BINARY_EXTENSIONS.test(path)) continue;
    let text: string;
    try {
      const buffer = readFileSync(`${root}${path}`);
      if (buffer.length > MAX_BYTES || buffer.includes(0)) continue;
      text = buffer.toString("utf8");
    } catch {
      continue; // listed but absent from the working tree (a deletion in progress): nothing to scan.
    }
    findings.push(...scanText(path, text));
  }
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const findings = await scanTracked();
  for (const finding of findings) process.stderr.write(`secret-scan: ${finding.rule} at ${finding.path}:${String(finding.line)}\n`);
  process.stdout.write(`secret-scan: ${String(findings.length)} finding(s)\n`);
  process.exit(findings.length === 0 ? 0 : 1);
}
