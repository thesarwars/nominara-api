import { z } from "zod";

// GET/PATCH /workspaces/{id} response body. Field set mirrors
// schemas/identity-and-tenancy.md's `workspaces` DDL, excluding columns with
// no reference-documented read path (`entitlement_overrides`,
// `dsar_contact_email`, deletion timestamps).
export const workspaceResponseSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    org_type: z.enum(["in_house", "agency"]),
    region: z.enum(["us-east-1", "eu-central-1"]),
    timezone: z.string(),
    plan_key: z.string(),
    entitlement_version: z.int(),
    status: z.enum([
      "trialing",
      "active",
      "past_due",
      "soft_capped",
      "suspended",
      "pending_deletion",
      "deleted",
    ]),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .strict();

export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;
