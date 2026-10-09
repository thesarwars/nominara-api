import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DEVELOPER_VALKEY_PORTS, isLoopbackHost } from "./test-valkey.js";

// STORY-174 — the static scanner behind test/unit/test-valkey-guard.spec.ts.
// DEFAULT IS "REPORT": a finding is a finding unless an allow-list entry names
// the exact file AND the exact matched text AND says why. An allow-list gap is
// never closed by adding a pattern exception here.

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: "valkey-url" | "developer-port" | "loopback-host" | "env-literal";
  /** The matched text — what an allow-list entry must name. */
  readonly match: string;
}

const URL_LITERAL = /\b(?:rediss?|valkey):\/\/[^\s"'`\\)<>]*/g;
const DEV_PORT_TOKEN = new RegExp(`(?<![\\w.])(${[...DEVELOPER_VALKEY_PORTS].join("|")})(?!\\w)`, "g");
const LOOPBACK_HOST_PROP = /\bhost\s*:\s*["'`](localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)["'`]/g;
const REDISISH_CONTEXT = /\b(?:ioredis|bullmq|IORedis|Redis|Queue|Worker|QueueEvents)\b/;
const ENV_LITERAL = /\b(?:QUEUE_REDIS_URL|VALKEY_CACHE_URL)["']?\s*[:=]\s*["'`]/g;

function hostAndPort(url: string): { host: string; port: number | undefined } | undefined {
  const m = /^[a-z]+:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?/i.exec(url);
  if (m === null || m[1] === undefined) return undefined;
  return { host: m[1], port: m[2] === undefined ? undefined : Number(m[2]) };
}

/** Scans one file's text. Pure — the spec drives it with strings, never files. */
export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const at = index + 1;
    for (const m of line.matchAll(URL_LITERAL)) {
      const parts = hostAndPort(m[0]);
      if (parts === undefined || parts.host.includes("${")) continue; // built at run time: the tripwire's job
      const portIsDeveloper = parts.port !== undefined && DEVELOPER_VALKEY_PORTS.has(parts.port);
      if (isLoopbackHost(parts.host) || portIsDeveloper) {
        findings.push({ file, line: at, rule: "valkey-url", match: m[0] });
      }
    }
    for (const m of line.matchAll(DEV_PORT_TOKEN)) {
      findings.push({ file, line: at, rule: "developer-port", match: m[1] as string });
    }
    const window = lines.slice(Math.max(0, index - 3), index + 1).join("\n");
    if (REDISISH_CONTEXT.test(window)) {
      for (const m of line.matchAll(LOOPBACK_HOST_PROP)) {
        findings.push({ file, line: at, rule: "loopback-host", match: m[0] });
      }
    }
    for (const m of line.matchAll(ENV_LITERAL)) {
      findings.push({ file, line: at, rule: "env-literal", match: m[0] });
    }
  });
  return findings;
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

const TEST_FILE = /(\.spec\.ts|\.test\.ts)$/;

/**
 * Every file a test run executes or loads: all of `test/` (specs AND support),
 * every `*.spec.ts`/`*.test.ts` under `src/` and `contracts/`, and the vitest
 * configs. Paths are repository-relative.
 */
export function testFiles(repoRoot: string): string[] {
  const out: string[] = [];
  for (const abs of walk(join(repoRoot, "test"))) if (abs.endsWith(".ts")) out.push(relative(repoRoot, abs));
  for (const root of ["src", "contracts"]) {
    for (const abs of walk(join(repoRoot, root))) if (TEST_FILE.test(abs)) out.push(relative(repoRoot, abs));
  }
  for (const name of readdirSync(repoRoot)) if (/^vitest.*\.ts$/.test(name)) out.push(name);
  return out.sort();
}

export function scanTree(repoRoot: string): Finding[] {
  return testFiles(repoRoot).flatMap((file) => scanText(file, readFileSync(join(repoRoot, file), "utf8")));
}
