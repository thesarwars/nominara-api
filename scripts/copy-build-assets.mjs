// `tsc` emits .js and copies nothing else. Three non-TypeScript assets are read
// from disk at run time, each at a path resolved relative to the compiled file,
// so they have to land in dist beside it:
//   src/db/migrations/sql          migrate-runner reads readdir(__dirname/migrations/sql)
//   src/lib/reports/fonts          export-pdf embeds Inter-*.ttf from ./fonts
//   contracts/openapi.generated.json   served as the committed spec document
// Usage: node scripts/copy-build-assets.mjs [outDir]   (default: dist)
import { cpSync, existsSync, mkdirSync } from "node:fs";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? resolve(root, "dist"));

const ASSETS = [
  ["src/db/migrations/sql", "src/db/migrations/sql"],
  ["src/lib/reports/fonts", "src/lib/reports/fonts"],
  ["contracts/openapi.generated.json", "contracts/openapi.generated.json"],
];

for (const [from, to] of ASSETS) {
  const source = resolve(root, from);
  if (!existsSync(source)) {
    process.stderr.write(`copy-build-assets: missing ${from}\n`);
    process.exit(1);
  }
  const target = resolve(out, to);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
