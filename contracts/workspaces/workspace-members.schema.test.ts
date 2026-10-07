import { describe, expect, it } from "vitest";
import { memberResponseSchema } from "./member-response.schema.js";
import { workspaceDetailResponseSchema } from "./workspace-detail-response.schema.js";
import { invitationRevokeParamsSchema } from "./invitation-revoke-params.schema.js";

const ID = "11111111-1111-7111-8111-111111111111";
const member = {
  id: ID,
  user_id: ID,
  name: null,
  email: "a@example.com",
  role: "owner",
  project_scope: null,
  status: "active",
  joined_at: "2026-01-01T00:00:00.000Z",
  last_active_at: null,
};

describe("NEW-A-12 · member / workspace-detail / invitation-revoke contracts", () => {
  it("a member carries a nullable name and an email; a missing email is refused", () => {
    expect(memberResponseSchema.parse(member)).toEqual(member);
    expect(memberResponseSchema.safeParse({ ...member, name: "Ada" }).success).toBe(true);
    const { email: _email, ...noEmail } = member;
    expect(memberResponseSchema.safeParse(noEmail).success).toBe(false);
    expect(memberResponseSchema.safeParse({ ...member, extra: 1 }).success).toBe(false);
  });
  it("workspace detail adds a nullable deletion_scheduled_at", () => {
    const detail = {
      id: ID, name: "W", slug: "w", org_type: "agency", region: "us-east-1", timezone: "UTC", plan_key: "growth",
      entitlement_version: 1, status: "active", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      deletion_scheduled_at: null,
    };
    expect(workspaceDetailResponseSchema.parse(detail)).toEqual(detail);
    expect(workspaceDetailResponseSchema.safeParse({ ...detail, deletion_scheduled_at: undefined }).success).toBe(false);
  });
  it("revoke params are two uuids and nothing else", () => {
    expect(invitationRevokeParamsSchema.safeParse({ id: ID, invitationId: ID }).success).toBe(true);
    expect(invitationRevokeParamsSchema.safeParse({ id: ID, invitationId: "x" }).success).toBe(false);
    expect(invitationRevokeParamsSchema.safeParse({ id: ID, invitationId: ID, z: 1 }).success).toBe(false);
  });
});
