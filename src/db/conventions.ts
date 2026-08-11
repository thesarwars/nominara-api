// The canonical source of truth for what STORY-006's migration is required to
// produce. src/db/drift-check.ts introspects a shadow database after applying
// every committed migration and fails the build if reality diverges from this
// list — this is what makes the list, not the SQL file, the thing engineers
// edit first when the foundation needs to change.

export const REQUIRED_EXTENSIONS = [
  "pgcrypto", // cryptographic functions
  "citext", // case-insensitive text
  "vector", // pgvector — embeddings
  "pg_trgm", // trigram search
  "btree_gin", // composite index support
  "pg_stat_statements", // statement statistics
] as const;

// data-model.md §1 "Extensions and shared helpers" — STORY-011 adds the
// tenant-context accessor functions into this same schema.
export const INTERNAL_SCHEMA = "app";

export const REQUIRED_INTERNAL_FUNCTIONS = [
  "touch_updated_at",
  "assert_jsonb_size",
] as const;
