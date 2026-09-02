import { defineConfig } from "drizzle-kit";

// STORY-122 — introspection only. Drizzle does NOT own migrations here, and
// that is settled rather than pending: drizzle-kit's diffing models no
// extensions, functions, triggers, roles, grants, RLS policies or
// partitions, which is migrations 0001, 0005, 0006 and 0007 in their
// entirety — plus src/db/rls/generate.ts, which generates 0006 from the
// database itself. system-architecture.md gives the reason in one line:
// "RLS requires literal control of transaction state."
//
// Migrations stay hand-authored SQL under src/db/migrations/, applied by
// src/db/migrate-runner.ts. The pgTable definitions under src/db/schema/
// DESCRIBE what those migrations produced and are generated FROM the
// migrated database by `pnpm db:schema-generate` — the direction of truth
// runs migrations → schema files and never back.
//
// `schema` points at the barrel rather than a glob, so drizzle-kit sees the
// generated table modules and not the generator, the subsystem map or the
// custom column types that sit beside them. There is deliberately no `out`:
// nothing here may write a migration.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://nominara:nominara@localhost:5432/nominara",
  },
});
