import { describe, expect, it } from "vitest";
import { createWorkspaceRequestSchema } from "../../contracts/workspaces/create-workspace-request.schema.js";
import { updateWorkspaceRequestSchema } from "../../contracts/workspaces/update-workspace-request.schema.js";
import { workspaceResponseSchema } from "../../contracts/workspaces/workspace-response.schema.js";
import {
  workspaceListItemSchema,
  workspaceListResponseSchema,
} from "../../contracts/workspaces/workspace-list-response.schema.js";
import { memberResponseSchema } from "../../contracts/workspaces/member-response.schema.js";
import { updateMemberRoleRequestSchema } from "../../contracts/workspaces/update-member-role-request.schema.js";
import { createInvitationRequestSchema } from "../../contracts/workspaces/create-invitation-request.schema.js";
import { invitationResponseSchema } from "../../contracts/workspaces/invitation-response.schema.js";
import { acceptInvitationRequestSchema } from "../../contracts/workspaces/accept-invitation-request.schema.js";

const VALID_WORKSPACE_ID = "018f3b3a-0000-7000-8000-000000000001";
const VALID_USER_ID = "018f3b3a-0000-7000-8000-000000000002";
const VALID_PROJECT_ID = "018f3b3a-0000-7000-8000-000000000003";
const NOW_ISO = "2026-08-19T00:00:00.000Z";

describe("STORY-021 · createWorkspaceRequestSchema (scenario 1 — create a workspace)", () => {
  it("accepts a minimal request carrying only name", () => {
    expect(createWorkspaceRequestSchema.safeParse({ name: "Acme" }).success).toBe(true);
  });

  it("accepts the optional org_type/region/timezone fields", () => {
    const result = createWorkspaceRequestSchema.safeParse({
      name: "Acme",
      org_type: "agency",
      region: "eu-central-1",
      timezone: "Europe/Berlin",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a request missing name", () => {
    expect(createWorkspaceRequestSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(createWorkspaceRequestSchema.safeParse({ name: "Acme", slug: "acme" }).success).toBe(false);
  });

  it("rejects a region outside the two CHECK-legal values", () => {
    expect(createWorkspaceRequestSchema.safeParse({ name: "Acme", region: "ap-south-1" }).success).toBe(false);
  });

  it("rejects a plan_key input — creation always lands on the free plan (STORY-021-E-2)", () => {
    expect(createWorkspaceRequestSchema.safeParse({ name: "Acme", plan_key: "growth" }).success).toBe(false);
  });
});

describe("STORY-021 · updateWorkspaceRequestSchema (scenario 4 — region change is refused, not ignored)", () => {
  it("accepts region as a structurally valid field, so the service can refuse it explicitly (STORY-021-E-8)", () => {
    expect(updateWorkspaceRequestSchema.safeParse({ region: "eu-central-1" }).success).toBe(true);
  });

  it("accepts an empty patch body", () => {
    expect(updateWorkspaceRequestSchema.safeParse({}).success).toBe(true);
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(updateWorkspaceRequestSchema.safeParse({ slug: "new-slug" }).success).toBe(false);
  });

  it("rejects a region outside the two CHECK-legal values", () => {
    expect(updateWorkspaceRequestSchema.safeParse({ region: "ap-south-1" }).success).toBe(false);
  });
});

describe("STORY-021 · workspaceResponseSchema", () => {
  const valid = {
    id: VALID_WORKSPACE_ID,
    name: "Acme",
    slug: "acme",
    org_type: "in_house",
    region: "us-east-1",
    timezone: "UTC",
    plan_key: "free",
    entitlement_version: 1,
    status: "active",
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
  };

  it("accepts a well-formed workspace row", () => {
    expect(workspaceResponseSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(workspaceResponseSchema.safeParse({ ...valid, entitlement_overrides: {} }).success).toBe(false);
  });

  it("rejects a status outside the seven CHECK-legal values", () => {
    expect(workspaceResponseSchema.safeParse({ ...valid, status: "archived" }).success).toBe(false);
  });
});

describe("STORY-117 · workspaceListResponseSchema — a flat list, separation kept per item", () => {
  const ownedItem = {
    workspace_id: VALID_WORKSPACE_ID,
    name: "Acme",
    slug: "acme",
    role: "owner",
    plan_key: "free",
    status: "active",
    relationship: "owned",
  };
  const joinedItem = { ...ownedItem, role: "manager", plan_key: "growth", relationship: "joined" };

  it("accepts a flat list whose items each declare their relationship and plan badge", () => {
    expect(workspaceListResponseSchema.safeParse([ownedItem, joinedItem]).success).toBe(true);
  });

  it("accepts an empty list (a user with no memberships yet)", () => {
    expect(workspaceListResponseSchema.safeParse([]).success).toBe(true);
  });

  // STORY-021's separation is the requirement and it survives — but it is now
  // carried by the item, so an item WITHOUT it is a response a switcher cannot
  // group. That must fail rather than default to one bucket.
  it("rejects an item with no relationship — the separation is not optional", () => {
    const { relationship: _dropped, ...withoutRelationship } = ownedItem;
    expect(workspaceListResponseSchema.safeParse([withoutRelationship]).success).toBe(false);
  });

  it("rejects a relationship outside owned|joined", () => {
    expect(workspaceListResponseSchema.safeParse([{ ...ownedItem, relationship: "invited" }]).success).toBe(false);
  });

  // Pins the N-1 break itself: the old shape must NOT still validate, or the
  // record in contracts/baseline/breaking-changes.json would describe a change
  // that did not happen.
  it("rejects the previous {owned, joined} shape", () => {
    expect(workspaceListResponseSchema.safeParse({ owned: [ownedItem], joined: [joinedItem] }).success).toBe(false);
  });

  it("rejects an unrecognized key on a list item (.strict())", () => {
    expect(workspaceListItemSchema.safeParse({ ...ownedItem, org_type: "in_house" }).success).toBe(false);
  });
});

describe("STORY-021 · memberResponseSchema", () => {
  const valid = {
    id: VALID_WORKSPACE_ID,
    user_id: VALID_USER_ID,
    role: "manager",
    project_scope: null,
    status: "active",
    joined_at: NOW_ISO,
    last_active_at: null,
  };

  it("accepts a well-formed membership row, including a null project_scope (every project)", () => {
    expect(memberResponseSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a scoped project_scope array of uuids", () => {
    expect(memberResponseSchema.safeParse({ ...valid, project_scope: [VALID_PROJECT_ID] }).success).toBe(true);
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(memberResponseSchema.safeParse({ ...valid, invited_by: VALID_USER_ID }).success).toBe(false);
  });

  it("rejects a role outside the five fixed roles", () => {
    expect(memberResponseSchema.safeParse({ ...valid, role: "superadmin" }).success).toBe(false);
  });
});

describe("STORY-021 · updateMemberRoleRequestSchema (scenarios 7-9 — ownership refusals are the service's job)", () => {
  it("accepts a non-owner role change", () => {
    expect(updateMemberRoleRequestSchema.safeParse({ role: "admin" }).success).toBe(true);
  });

  it("accepts role: 'owner' at the schema level — STORY-021-E-9 requires the SERVICE, not this contract, to produce the two distinct refusal shapes", () => {
    expect(updateMemberRoleRequestSchema.safeParse({ role: "owner" }).success).toBe(true);
  });

  it("accepts an optional project_scope reassignment", () => {
    expect(updateMemberRoleRequestSchema.safeParse({ role: "manager", project_scope: [VALID_PROJECT_ID] }).success).toBe(true);
  });

  it("rejects an unrecognized role value", () => {
    expect(updateMemberRoleRequestSchema.safeParse({ role: "superadmin" }).success).toBe(false);
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(updateMemberRoleRequestSchema.safeParse({ role: "admin", status: "active" }).success).toBe(false);
  });
});

describe("STORY-021 · createInvitationRequestSchema (scenario 10 — invitations never grant ownership)", () => {
  it("accepts each of the four non-owner roles", () => {
    for (const role of ["admin", "manager", "analyst", "viewer"]) {
      expect(createInvitationRequestSchema.safeParse({ email: "a@example.com", role }).success, role).toBe(true);
    }
  });

  it("rejects role: 'owner' — an invitation must never be able to grant ownership", () => {
    expect(createInvitationRequestSchema.safeParse({ email: "a@example.com", role: "owner" }).success).toBe(false);
  });

  it("accepts an optional project_scope", () => {
    const result = createInvitationRequestSchema.safeParse({
      email: "a@example.com",
      role: "manager",
      project_scope: [VALID_PROJECT_ID],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed email", () => {
    expect(createInvitationRequestSchema.safeParse({ email: "not-an-email", role: "viewer" }).success).toBe(false);
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(
      createInvitationRequestSchema.safeParse({ email: "a@example.com", role: "viewer", message: "hi" }).success,
    ).toBe(false);
  });
});

describe("STORY-021 · invitationResponseSchema", () => {
  const valid = {
    id: VALID_WORKSPACE_ID,
    workspace_id: VALID_WORKSPACE_ID,
    email: "a@example.com",
    role: "manager",
    project_scope: null,
    expires_at: NOW_ISO,
    created_at: NOW_ISO,
  };

  it("accepts the response without a token (the list path)", () => {
    expect(invitationResponseSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts the response with a token (the create path — shown once)", () => {
    expect(invitationResponseSchema.safeParse({ ...valid, token: "raw-secret" }).success).toBe(true);
  });

  it("rejects role: 'owner'", () => {
    expect(invitationResponseSchema.safeParse({ ...valid, role: "owner" }).success).toBe(false);
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(invitationResponseSchema.safeParse({ ...valid, invited_by: VALID_USER_ID }).success).toBe(false);
  });
});

describe("STORY-021 · acceptInvitationRequestSchema (scenario 11 — accepting an invitation)", () => {
  it("accepts a request carrying only the raw token", () => {
    expect(acceptInvitationRequestSchema.safeParse({ token: "raw-secret" }).success).toBe(true);
  });

  it("rejects an empty token", () => {
    expect(acceptInvitationRequestSchema.safeParse({ token: "" }).success).toBe(false);
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(acceptInvitationRequestSchema.safeParse({ token: "raw-secret", role: "manager" }).success).toBe(false);
  });
});
