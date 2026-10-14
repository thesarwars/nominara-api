import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import { incrementCounter } from "../lib/telemetry/metrics.js";
import { generateOpenApiDocument } from "./generate.js";
import { checkPermissionMatrixDrift, PERMISSION_MATRIX_ARTIFACT_PATH } from "./permission-matrix-artifact.js";

// STORY-023 T3 (GREEN step) — AC3: "A drift check compares the schemas
// against the committed document and fails the build. There is NO WARNING
// MODE, and hand-editing the document is never correct." Regenerates from
// the live `@ApiContract()` metadata (generate.ts) and compares the result
// against `documentPath` — never the other way round, and never a
// partial/sampled comparison.
//
// Accepts a document-path override as `process.argv[2]`, defaulting to the
// real committed `contracts/openapi.generated.json` only when omitted —
// this is what lets contracts-drift-check.spec.ts point THIS exact CLI at
// a fixture copy without ever touching the real committed file on disk.
const logger = new Logger("contracts:check");

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const DEFAULT_DOCUMENT_PATH = resolve(REPO_ROOT, "contracts/openapi.generated.json");

export interface DriftCheckResult {
  readonly clean: boolean;
  readonly documentPath: string;
}

// Order-INSENSITIVE structural comparison — a generated document's own key
// insertion order is already made deterministic by generate.ts (sorted
// path keys, sorted controller-file walk), but the COMMITTED file on disk
// is git history a human may have reformatted (whitespace, key order) at
// some point without changing its meaning; the drift check's job is
// "do the SCHEMAS match", never "does the byte layout match".
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Pure — takes an already-resolved document path, never reaches for
 * `process.argv`/`process.exit` itself (same "explicit input, no implicit
 * disk read baked into the pure logic" shape as
 * src/db/drift-check.ts's checkDrift() / src/db/rls/rls-check.ts's
 * checkRls()).
 */
export async function checkDrift(documentPath: string): Promise<DriftCheckResult> {
  const committed: unknown = JSON.parse(readFileSync(documentPath, "utf8"));
  const generated = await generateOpenApiDocument();
  return { clean: stableStringify(generated) === stableStringify(committed), documentPath };
}

async function main(): Promise<void> {
  const documentPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_DOCUMENT_PATH;
  const result = await checkDrift(documentPath);

  // coding-standards.md §7 — one metric, one redacted log line, both
  // verified running (never assumed). The log line names the PATH checked
  // — never workspace names, credentials, or engine text; there is no
  // tenant/customer data anywhere in a contract-generation run.
  incrementCounter("nominara_contracts_drift_check_total", { result: result.clean ? "clean" : "drift" });
  logger.log(`contracts:check ${result.clean ? "passed — no drift" : "FAILED — drift detected"} against ${documentPath}`);

  if (!result.clean) {
    console.error(
      `contracts:check FAILED — the OpenAPI document regenerated from the live zod schemas does not match ${documentPath}. ` +
        'Run "pnpm contracts:generate" and commit the result. There is no warning mode (AC3) — hand-editing the document is never correct.',
    );
    process.exit(1);
  }

  console.log(`contracts:check passed — no drift against ${documentPath}`);

  // STORY-019 — the generated permission matrix artifact is checked in the
  // same step, same no-warning-mode rule. argv[3] overrides its path (tests).
  const matrixPath = process.argv[3] ? resolve(process.argv[3]) : PERMISSION_MATRIX_ARTIFACT_PATH;
  const matrix = checkPermissionMatrixDrift(matrixPath);
  incrementCounter("nominara_contracts_permission_matrix_drift_check_total", {
    result: matrix.clean ? "clean" : "drift",
  });
  logger.log(`contracts:check permission matrix ${matrix.clean ? "passed — no drift" : "FAILED — drift detected"} against ${matrixPath}`);
  if (!matrix.clean) {
    console.error(
      `contracts:check FAILED — the permission matrix artifact regenerated from PERMISSION_MATRIX does not match ${matrixPath}. ` +
        'Run "pnpm contracts:generate" and commit the result. There is no warning mode — hand-editing the artifact is never correct.',
    );
    process.exit(1);
  }
  console.log(`contracts:check passed — permission matrix has no drift against ${matrixPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
