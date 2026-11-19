import { Logger } from "@nestjs/common";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuxCatalog } from "./catalog.js";
import { readCatalogSql } from "./catalog-from-migrations.js";
import { runStaticAudit, StaticAuditError, type StaticAuditInput } from "./static-audit.js";
import { HostHeadersError, parseHeadersFile, parseVercelJson, type HostHeaderRule } from "./static-host-headers.js";

// STORY-102 AC10 / owner decision 68(j) - `pnpm aux:audit-static <dir> [--min-score N] [--allow-partial] [--base-url URL]`.
//
// Runs the AUX rules over a directory of built static HTML and prints ONE JSON document on stdout: the score, the findings, and the rules that were
// not evaluated (with why). No network, no database. Exit codes:
//   0  audited; no --min-score given, or the score is at or above it
//   1  audited; the score is BELOW --min-score
//   2  could not audit (bad arguments, an unreadable or empty directory, nothing modellable, an unreadable host headers file), OR --min-score was given
//      and the audit did not cover the whole site: a page was skipped (a symbolic link, an oversized file) or could not be modelled, and --allow-partial
//      was not given. A score over fewer pages than the site has is not the site's score, so a gate must not pass on it. In the first case stdout is
//      empty; in the second stdout carries the full report with `passed: false` and an `incomplete` block naming what was left out, and stderr the reason.
//      Either way a JSON `{"error": ...}` goes to STDERR. The host's own 404 page is not a page of the site and never makes an audit incomplete.
// stdout carries nothing but the report: the platform's own logging is switched off for this process, so a CI step can pipe it to a JSON parser.

export const EXIT_OK = 0;
export const EXIT_BELOW_MIN_SCORE = 1;
export const EXIT_UNABLE = 2;

const DEFAULT_BASE_URL = "https://site.invalid";
/** A page larger than this is skipped and reported (the rules are measured on pages of about 2 MB; a build output beyond this is not a page). */
const MAX_PAGE_BYTES = 10 * 1024 * 1024;

export interface CliOptions {
  readonly dir: string;
  readonly minScore: number | null;
  readonly baseUrl: string;
  /** Gate on the score even when pages were skipped or could not be modelled. */
  readonly allowPartial: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let dir: string | null = null;
  let minScore: number | null = null;
  let baseUrl = DEFAULT_BASE_URL;
  let allowPartial = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const valueOf = (): string => {
      const eq = arg.indexOf("=");
      if (eq >= 0) return arg.slice(eq + 1);
      i += 1;
      const next = argv[i];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      return next;
    };
    if (arg === "--min-score" || arg.startsWith("--min-score=")) {
      const raw = valueOf();
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > 100) throw new UsageError("--min-score must be a number from 0 to 100");
      minScore = value;
    } else if (arg === "--allow-partial") {
      allowPartial = true;
    } else if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      const raw = valueOf();
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new UsageError("--base-url must be an absolute http(s) URL");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError("--base-url must be an absolute http(s) URL");
      baseUrl = url.origin;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown option ${arg}`);
    } else if (dir === null) {
      dir = arg;
    } else {
      throw new UsageError("only one directory may be given");
    }
  }
  if (dir === null) throw new UsageError("usage: aux:audit-static <dir> [--min-score N] [--allow-partial] [--base-url URL]");
  return { dir, minScore, baseUrl, allowPartial };
}

/** The URL path a built file is served at: `index.html` is its directory, any other `.html` file is itself. */
export function urlPathOf(relativeFile: string): string {
  const parts = relativeFile.split(sep).join("/");
  if (parts === "index.html") return "/";
  if (parts.endsWith("/index.html")) return `/${parts.slice(0, -"index.html".length)}`;
  return `/${parts}`;
}

interface Walked {
  readonly pages: Array<{ path: string; html: string }>;
  readonly skipped: Array<{ file: string; reason: string }>;
  readonly files: Map<string, string>;
}

/** Host header files, read from the root only. Neither is a page, and neither is reported as skipped. */
const HOST_HEADER_FILES = ["_headers", "vercel.json"] as const;

const SITE_FILE_PATHS = ["robots.txt", "llms.txt", ".well-known/llms.txt", "sitemap.xml", "sitemap-index.xml", ...HOST_HEADER_FILES];

/**
 * Every `.html` file under `root`, in a fixed order, and the few site files. A symbolic link is never followed (a build output that links outside its own
 * directory is not read through), and a dot-directory other than `.well-known` is not entered.
 */
async function walk(root: string): Promise<Walked> {
  const pages: Walked["pages"] = [];
  const skipped: Walked["skipped"] = [];
  const files = new Map<string, string>();
  const visit = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (entry.isSymbolicLink()) {
        skipped.push({ file: rel.split(sep).join("/"), reason: "symlink" });
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
        await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relPosix = rel.split(sep).join("/");
      if (SITE_FILE_PATHS.includes(relPosix)) {
        files.set(relPosix, await readFile(full, "utf8"));
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".html")) continue;
      // The host's error page is not a page of the site: it is served with a 404.
      if (relPosix === "404.html") {
        skipped.push({ file: relPosix, reason: "error_page" });
        continue;
      }
      if ((await lstat(full)).size > MAX_PAGE_BYTES) {
        skipped.push({ file: relPosix, reason: "too_large" });
        continue;
      }
      pages.push({ path: urlPathOf(rel), html: await readFile(full, "utf8") });
    }
  };
  await visit(root);
  return { pages, skipped, files };
}

/** The host headers file the directory holds, or null. `_headers` wins when both exist and both say something (Netlify and Vercel do not share a deploy). */
function readHostHeaders(files: ReadonlyMap<string, string>): { readonly file: string; readonly rules: readonly HostHeaderRule[] } | null {
  const plain = files.get("_headers");
  const vercel = files.get("vercel.json");
  const rules: HostHeaderRule[] = [];
  let used: string | null = null;
  if (plain !== undefined) {
    rules.push(...parseHeadersFile(plain));
    used = "_headers";
  }
  if (vercel !== undefined) {
    const parsed = parseVercelJson(vercel);
    if (parsed !== null) {
      rules.push(...parsed);
      used = used === null ? "vercel.json" : "_headers+vercel.json";
    }
  }
  return used === null ? null : { file: used, rules };
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCli(argv: readonly string[], now: Date = new Date()): Promise<CliResult> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return { exitCode: EXIT_UNABLE, stdout: "", stderr: `${JSON.stringify({ error: error instanceof Error ? error.message : "invalid arguments" })}\n` };
  }
  try {
    const root = resolve(options.dir);
    const walked = await walk(root);
    const sitemap = walked.files.get("sitemap.xml") ?? walked.files.get("sitemap-index.xml") ?? null;
    const hostHeaders = readHostHeaders(walked.files);
    const input: StaticAuditInput = {
      pages: walked.pages,
      siteFiles: { robots: walked.files.get("robots.txt") ?? null, llms: walked.files.get("llms.txt") ?? null, llmsWellKnown: walked.files.get(".well-known/llms.txt") ?? null, sitemap },
      baseUrl: options.baseUrl,
      now,
      catalog: loadAuxCatalog(readCatalogSql()),
      hostHeaders: hostHeaders === null ? null : hostHeaders.rules,
    };
    const report = await runStaticAudit(input);
    const below = options.minScore !== null && report.score < options.minScore;
    // The 404 page is the host's error page, not a page of the site; everything else that was skipped, or that the model could not read, is a page the
    // score does not cover.
    const leftOut = walked.skipped.filter((entry) => entry.reason !== "error_page");
    const incomplete =
      options.minScore !== null && !options.allowPartial && (leftOut.length > 0 || report.pages_unmodelled.length > 0)
        ? { pages_skipped: leftOut, pages_unmodelled: report.pages_unmodelled }
        : null;
    const document = {
      target: { directory: options.dir, base_url: options.baseUrl, pages_skipped: walked.skipped, host_headers: hostHeaders === null ? null : hostHeaders.file },
      min_score: options.minScore,
      passed: options.minScore === null ? null : incomplete === null && !below,
      ...(incomplete === null ? {} : { incomplete }),
      ...report,
    };
    if (incomplete !== null) {
      const message = `the audit did not cover the whole site (${String(incomplete.pages_skipped.length)} skipped, ${String(incomplete.pages_unmodelled.length)} not modelled), so --min-score cannot be decided; fix them or pass --allow-partial`;
      return { exitCode: EXIT_UNABLE, stdout: `${JSON.stringify(document, null, 2)}\n`, stderr: `${JSON.stringify({ error: message })}\n` };
    }
    return { exitCode: below ? EXIT_BELOW_MIN_SCORE : EXIT_OK, stdout: `${JSON.stringify(document, null, 2)}\n`, stderr: "" };
  } catch (error) {
    const message =
      error instanceof StaticAuditError || error instanceof HostHeadersError
        ? error.message
        : (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR"
          ? "the directory does not exist or is not a directory"
          : `audit failed (${error instanceof Error ? error.name : "unknown"})`;
    return { exitCode: EXIT_UNABLE, stdout: "", stderr: `${JSON.stringify({ error: message })}\n` };
  }
}

async function main(): Promise<void> {
  // The engine counts and logs through Nest's Logger; stdout is the report and only the report.
  Logger.overrideLogger(false);
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
