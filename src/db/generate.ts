import { writeFile } from "node:fs/promises";
import path from "node:path";
import { listMigrationFiles, MIGRATIONS_DIR } from "./migrate-runner.js";

const rawName = process.argv[2];
if (!rawName) {
  console.error("usage: pnpm db:generate <kebab-case-name>");
  process.exit(1);
}

const kebabName = rawName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
const existing = await listMigrationFiles();
const nextSeq = existing.length + 1;
const seqPrefix = String(nextSeq).padStart(4, "0");
const stem = `${seqPrefix}_${kebabName}`;

const upPath = path.join(MIGRATIONS_DIR, `${stem}.up.sql`);
const downPath = path.join(MIGRATIONS_DIR, `${stem}.down.sql`);

await writeFile(upPath, `-- ${stem}: describe the change\n`, { flag: "wx" });
await writeFile(downPath, `-- ${stem}: reverse of the up migration\n`, { flag: "wx" });

console.log(`created ${upPath}`);
console.log(`created ${downPath}`);
