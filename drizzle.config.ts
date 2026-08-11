import { defineConfig } from "drizzle-kit";

// No schema.ts files exist yet — STORY-007 adds the first table definitions
// under src/db/schema/. Extensions, internal functions, and triggers (this
// story, STORY-006) are hand-authored SQL under src/db/migrations/ instead,
// since drizzle-kit's schema diffing does not model extensions or functions.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/*.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://nominara:nominara@localhost:5432/nominara",
  },
});
