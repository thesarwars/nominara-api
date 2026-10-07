import { describe, expect, it } from "vitest";
import { z } from "zod";
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
    expect(memberResponseSchema.safeParse({ ...member, email: 7 }).success).toBe(false);
    expect(memberResponseSchema.safeParse({ ...member, extra: 1 }).success).toBe(false);
  });
  it("NEW-A-12 audit · name and email are OPTIONAL on the wire, so adding them is additive (contracts:diff patch, not major)", () => {
    const { name: _name, email: _email, ...legacy } = member;
    expect(memberResponseSchema.safeParse(legacy).success).toBe(true);
    const required = (z.toJSONSchema(memberResponseSchema, { io: "output" }) as { required?: string[] }).required ?? [];
    expect(required).not.toContain("name");
    expect(required).not.toContain("email");
    expect(required).toEqual(expect.arrayContaining(["id", "user_id", "role", "status"]));
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
