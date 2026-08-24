import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateClient, generateOpenApiDocument } from "./generate.js";

// STORY-023 T4 — `pnpm client:generate`. Generates `@nominara/client`'s
// contents from the SAME in-memory document `contracts:generate` commits and
// `contracts:check` gates, so the published client can never describe a route
// the specification does not (project-structure.md §6: "Generated, never
// hand-written").
//
// The output directory is gitignored on purpose. `contracts/openapi.generated.json`
// is committed because a drift gate (NFR-REPO-01) protects it; there is no
// equivalent gate for the client, and an uncovered committed artifact is the
// same "two descriptions of one contract" failure ADR-0002 argues against —
// just moved downstream. NFR-REPO-02's release job regenerates it at publish
// time. Accepts an out-dir override as `process.argv[2]`.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const DEFAULT_CLIENT_OUT_DIR = resolve(REPO_ROOT, "client/src");

async function main(): Promise<void> {
  const outDir = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_CLIENT_OUT_DIR;
  mkdirSync(outDir, { recursive: true });
  const document = await generateOpenApiDocument();
  await generateClient(document, outDir);
  console.log(`client:generate — wrote @nominara/client sources to ${outDir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
