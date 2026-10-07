import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { tasks } from "../../src/db/schema/tasks.js";
import { taskListQuerySchema, taskSchema, taskSortSchema, taskStatusSchema } from "./index.js";

// STORY-064 test #3 — "Search the schema and API for an ordering field: None
// exists." Three independent searches, so one blind spot cannot hide it:
// the table's columns, the zod-introspected contract keys, and the contract
// source text itself.
const ORDERING_NAME = /(^|_)(order|ordering|position|rank|ranking|lane|lane_order|sort_index|sequence|seq)($|_)/;

describe("STORY-064 · task contract", () => {
  it("[STORY-064 #3] the tasks table has no ordering column", () => {
    const columns = Object.values(getTableColumns(tasks)).map((c) => c.name);
    expect(columns.length).toBeGreaterThan(20);
    expect(columns.filter((name) => ORDERING_NAME.test(name))).toEqual([]);
  });

  it("[STORY-064 #3] the task response and list query declare no ordering member (zod introspection)", () => {
    const responseKeys = Object.keys(taskSchema.shape);
    const queryKeys = Object.keys(taskListQuerySchema.shape);
    expect(responseKeys).toContain("impact_score");
    expect(responseKeys.filter((k) => ORDERING_NAME.test(k))).toEqual([]);
    // `sort` is a READ ordering by measured fields, never a stored position.
    expect(queryKeys.sort()).toEqual(["cursor", "limit", "sort", "status"]);
    expect(queryKeys.filter((k) => ORDERING_NAME.test(k))).toEqual([]);
  });

  it("[STORY-064 #3] no contract source under contracts/tasks mentions a lane or a manual order", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith(".schema.ts"));
    expect(sources.length).toBeGreaterThanOrEqual(3);
    for (const file of sources) {
      const text = readFileSync(join(dir, file), "utf8");
      // Executable lines only: comments legitimately say "no ordering field".
      const code = text.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"));
      expect(code.join("\n"), file).not.toMatch(/lane_order|sort_index|\bposition\b|drag/i);
    }
  });

  it("[STORY-064 #2] exactly four sorts and four statuses", () => {
    expect(taskSortSchema.options).toEqual(["impact", "priority", "age", "goal"]);
    expect(taskStatusSchema.options).toEqual(["todo", "in_progress", "done", "dismissed"]);
  });

  it("the list query is strict and defaults to impact", () => {
    expect(taskListQuerySchema.parse({}).sort).toBe("impact");
    expect(taskListQuerySchema.safeParse({ order: "asc" }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ sort: "manual" }).success).toBe(false);
    expect(taskListQuerySchema.parse({ limit: "500" }).limit).toBe(200);
  });

  it("the task response is strict", () => {
    const base = {
      id: "0198f6a0-0000-7000-8000-000000000001", short_ref: "HUB-1", project_id: "0198f6a0-0000-7000-8000-000000000002",
      goal_id: null, title: "t", description: "d", kind: "content", origin: "auto", status: "todo", severity: null,
      source: "content", rule_code: null, priority: 3, impact_score: 10, effort: null, assignee_id: null, due_at: null,
      dismissed_reason: null, resurface_at: null, completed_at: null, affected_url: null, created_at: "x", updated_at: "x",
    };
    expect(taskSchema.safeParse(base).success).toBe(true);
    expect(taskSchema.safeParse({ ...base, lane_order: 1 }).success).toBe(false);
  });
});
