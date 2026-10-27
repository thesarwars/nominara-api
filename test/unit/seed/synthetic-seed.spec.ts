import { describe, expect, it } from "vitest";
import { PLAN_ENTITLEMENTS } from "../../../src/db/seed/plan-entitlements.js";
import {
  SYNTHETIC_GRANT_CREDITS,
  SYNTHETIC_GRANT_IDEMPOTENCY_KEY,
  SYNTHETIC_TENANTS,
} from "../../../src/db/seed/synthetic/constants.js";
import { assertSyntheticSeedAllowed } from "../../../src/db/seed/synthetic/guard.js";

// STORY-004 AC5 — the awkward shapes, asserted on the data itself so a later
// edit that "tidies" a name cannot quietly remove the shape it exists for.

const allProjects = SYNTHETIC_TENANTS.flatMap((tenant) => tenant.projects);
const words = (name: string): string[] => name.trim().split(/\s+/u);

function finiteLimit(plan: string, key: string): number {
  const value = PLAN_ENTITLEMENTS[plan as keyof typeof PLAN_ENTITLEMENTS]?.[key]?.value;
  if (typeof value !== "number") throw new Error(`${plan}.${key} is not a finite number`);
  return value;
}

describe("STORY-004 AC5 · synthetic seed shapes", () => {
  it("is three tenants, one per paid tier (owner decision 2026-10-27 item 5)", () => {
    expect(SYNTHETIC_TENANTS).toHaveLength(3);
    expect(SYNTHETIC_TENANTS.map((tenant) => tenant.planKey).sort()).toEqual(["business", "growth", "starter"]);
  });

  it("gives every owner an address on the reserved nominara.test domain", () => {
    for (const tenant of SYNTHETIC_TENANTS) {
      expect(tenant.ownerEmail).toMatch(/^[a-z0-9-]+@nominara\.test$/u);
    }
    expect(new Set(SYNTHETIC_TENANTS.map((tenant) => tenant.ownerEmail)).size).toBe(3);
  });

  it("has a common-word brand: a single lowercase dictionary-style word", () => {
    expect(allProjects.some((project) => words(project.name).length === 1 && /^[A-Z][a-z]+$/u.test(project.name))).toBe(true);
  });

  it("has a multi-word brand", () => {
    expect(allProjects.some((project) => words(project.name).length >= 3)).toBe(true);
  });

  it("has a substring-colliding competitor pair inside one project", () => {
    const collides = allProjects.some((project) =>
      project.competitors.some((a) =>
        project.competitors.some((b) => a !== b && b.name.toLowerCase().includes(a.name.toLowerCase())),
      ),
    );
    expect(collides).toBe(true);
  });

  it("has a project with exactly one prompt", () => {
    expect(allProjects.some((project) => project.prompts.length === 1)).toBe(true);
  });

  it("fits every tenant inside its own plan's structural limits", () => {
    for (const tenant of SYNTHETIC_TENANTS) {
      expect(tenant.projects.length, `${tenant.key} projects`).toBeLessThanOrEqual(finiteLimit(tenant.planKey, "projects.max"));
      for (const project of tenant.projects) {
        expect(project.prompts.length, `${project.name} prompts`).toBeLessThanOrEqual(finiteLimit(tenant.planKey, "prompts.free_at_creation"));
        expect(project.competitors.length, `${project.name} competitors`).toBeLessThanOrEqual(
          finiteLimit(tenant.planKey, "competitors.max_per_project"),
        );
      }
    }
  });

  it("uses fixed, unique UUIDv7-shaped identifiers so a re-seed targets the same rows", () => {
    const ids = [...SYNTHETIC_TENANTS.map((tenant) => tenant.workspaceId), ...allProjects.map((project) => project.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    }
  });

  it("grants a fixed 500 credits under one deterministic key, outside every server-written grant namespace", () => {
    expect(SYNTHETIC_GRANT_CREDITS).toBe(500);
    expect(SYNTHETIC_GRANT_IDEMPOTENCY_KEY).toBe("seed:synthetic:grant:v1");
    // provisionWalletWithGrant keys `grant:provision:<cycle>`; a cycle roll keys `cycle_roll:<day>`.
    expect(SYNTHETIC_GRANT_IDEMPOTENCY_KEY.startsWith("grant:")).toBe(false);
    expect(SYNTHETIC_GRANT_IDEMPOTENCY_KEY.startsWith("cycle_roll:")).toBe(false);
  });
});

describe("STORY-004 AC5 · the synthetic seed's refusal", () => {
  const local = {
    nodeEnv: "development",
    databaseUrl: "postgres://nominara:nominara@localhost:5432/nominara",
    databaseUrlPooled: "postgres://nominara_app:pw@localhost:6432/nominara",
    optIn: "1",
  };

  it("allows a local target with the opt-in", () => {
    expect(() => assertSyntheticSeedAllowed(local)).not.toThrow();
  });

  it("refuses NODE_ENV=production", () => {
    expect(() => assertSyntheticSeedAllowed({ ...local, nodeEnv: "production" })).toThrow(/NODE_ENV=production/u);
  });

  it("refuses a non-local DATABASE_URL", () => {
    expect(() => assertSyntheticSeedAllowed({ ...local, databaseUrl: "postgres://u:p@db.internal.example.com/nominara" })).toThrow(
      /DATABASE_URL names "db\.internal\.example\.com"/u,
    );
  });

  it("refuses a non-local DATABASE_URL_POOLED, including the ?host= override", () => {
    expect(() =>
      assertSyntheticSeedAllowed({ ...local, databaseUrlPooled: "postgres://u:p@localhost/nominara?host=prod.example.com" }),
    ).toThrow(/DATABASE_URL_POOLED names "prod\.example\.com"/u);
  });

  it("refuses without its own opt-in, NOMINARA_SYNTHETIC_SEED=1", () => {
    expect(() => assertSyntheticSeedAllowed({ ...local, optIn: undefined })).toThrow(/NOMINARA_SYNTHETIC_SEED=1/u);
  });

  it("names synthetic data, not demo data, in its refusal", () => {
    expect(() => assertSyntheticSeedAllowed({ ...local, nodeEnv: "production" })).toThrow(/synthetic tenants/u);
  });
});
