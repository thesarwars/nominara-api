import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOCUMENT_PATH = resolve(REPO_ROOT, "contracts/openapi.generated.json");

// STORY-023 T3 (GREEN step) — AC8: "The specification is served from a
// documented route so a consumer can fetch it." M6 (coordinator's code-
// review round 2, carried into this task's brief): the served document
// must be the exact COMMITTED file `@nominara/client` was generated from
// — never a runtime reconstruction, which could differ from it (a boot-
// time regeneration would also reopen NFR-API-06's "no internal-only
// schema" surface to whatever the live container happens to produce,
// rather than the reviewed, drift-checked artifact). Read once and cached
// — the file does not change while the process is running.
let cachedDocument: unknown;

export function loadCommittedOpenApiDocument(): unknown {
  if (cachedDocument === undefined) {
    cachedDocument = JSON.parse(readFileSync(DOCUMENT_PATH, "utf8"));
  }
  return cachedDocument;
}
