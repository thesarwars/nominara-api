import { describe, expect, it } from "vitest";
import { conflictDetailsSchema } from "../../contracts/common/error-details.schema.js";
import { RESERVED_WORKSPACE_SLUGS, isReservedWorkspaceSlug } from "../../contracts/workspaces/reserved-slugs.js";

describe("owner decision 96(c) · reserved workspace slugs", () => {
  it("the owner's list is reserved, whatever the case", () => {
    for (const slug of ["admin", "api", "www", "app", "support", "help", "billing", "status", "ADMIN"]) expect(isReservedWorkspaceSlug(slug), slug).toBe(true);
  });
  it("the system paths the router owns are reserved", () => {
    for (const slug of ["auth", "sso", "sign-in", "sign-up", "onboarding", "settings", "portal", "agency", "v1", "health", "workspaces"]) expect(RESERVED_WORKSPACE_SLUGS, slug).toContain(slug);
  });
  it("an ordinary slug, or one that only contains a reserved word, is not reserved", () => {
    for (const slug of ["acme", "admin-co", "my-app", "apps"]) expect(isReservedWorkspaceSlug(slug), slug).toBe(false);
  });
  it("slug_reserved is an accepted conflict reason", () => {
    expect(conflictDetailsSchema.safeParse({ reason: "slug_reserved" }).success).toBe(true);
  });
});
