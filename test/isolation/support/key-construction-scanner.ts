import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// STORY-012 T20/T21 · D-3/D-4 — no Valkey or S3/IAM infra exists yet in this
// repo (D-3, D-6), so ISO-13/ISO-14 are implemented as a FAIL-CLOSED SCANNER
// over key-construction call sites in src/, rather than a real cache/bucket
// integration test. Today this legitimately finds ZERO call sites in src/ —
// that is the expected, documented result (T20: "likely finds zero today,
// that's expected and must not silently pass"), not a scanner bug. To make
// "zero findings" trustworthy rather than indistinguishable from "the
// scanner is broken", every scan is ALSO run against a small fixture
// directory (./namespace-fixtures) containing one deliberately-good and one
// deliberately-bad literal of each shape — the scanner MUST find and
// correctly classify both, every time, or the suite fails loudly before it
// ever gets to trust an empty src/ result.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const NAMESPACE_FIXTURES_DIR = path.join(__dirname, "namespace-fixtures");
const SRC_DIR = path.join(__dirname, "..", "..", "..", "src");

export interface ScanMatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const s = await stat(full);
      if (s.isDirectory()) await walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  }
  await walk(root);
  return out;
}

/** Scans every .ts file under `root` for lines matching `pattern`, returning each match's captured key literal (group 1). */
export async function scanForKeyLiterals(root: string, pattern: RegExp): Promise<ScanMatch[]> {
  const files = await listFilesRecursive(root);
  const matches: ScanMatch[] = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = pattern.exec(line);
      pattern.lastIndex = 0; // pattern is reused across lines; global flag requires manual reset
      if (m && m[1]) {
        matches.push({ file, line: i + 1, text: m[1] });
      }
    }
  }
  return matches;
}

export async function scanSrcForKeyLiterals(pattern: RegExp): Promise<ScanMatch[]> {
  return scanForKeyLiterals(SRC_DIR, pattern);
}

export async function scanFixturesForKeyLiterals(pattern: RegExp): Promise<ScanMatch[]> {
  return scanForKeyLiterals(NAMESPACE_FIXTURES_DIR, pattern);
}
