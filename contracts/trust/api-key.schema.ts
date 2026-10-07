import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";

// NEW-D-1 — `/v1/api-keys` (apikey:create, step-up). Mirrors `api_keys`.
//
// OWNER DECISIONS:
//   permissions default  LEAST PRIVILEGE: read-only. A create that omits
//                        `permissions` gets API_KEY_DEFAULT_PERMISSIONS; a key
//                        never silently inherits the creator's role.
//   prefix               `nk_live_` / `nk_test_` follows the Stripe mode.
//   hash                 SHA-256 of a high-entropy secret (handler concern).
// Whether each permission string is a real, grantable permission is checked
// against the permission matrix by the handler, which refuses anything the
// creator does not hold. Shape only here.
export const API_KEY_DEFAULT_PERMISSIONS = ["workspace:read", "project:read", "tracking:read"] as const;

export const API_KEY_PREFIX_PATTERN = /^nk_(live|test)_[A-Za-z0-9]{4,12}$/u;

const permissionString = z.string().regex(/^[a-z_]+:[a-z_]+$/u);

export const apiKeyCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    permissions: z.array(permissionString).min(1).max(40).default([...API_KEY_DEFAULT_PERMISSIONS]),
    /** Null/absent = every project the creator can reach. */
    project_scope: z.array(z.uuid()).min(1).max(100).nullable().default(null),
    expires_at: z.iso.datetime().nullable().default(null),
  })
  .strict();

export const apiKeySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** Display only; the secret is not recoverable from it. */
    key_prefix: z.string().regex(API_KEY_PREFIX_PATTERN),
    permissions: z.array(permissionString),
    project_scope: z.array(z.uuid()).nullable(),
    created_by: z.uuid(),
    last_used_at: z.iso.datetime().nullable(),
    expires_at: z.iso.datetime().nullable(),
    created_at: z.iso.datetime(),
  })
  .strict();

// ⚠ `secret` IS RETURNED ONCE, ON CREATE, AND IS NOT A MEMBER OF `apiKeySchema`
// ON PURPOSE: a list or read response cannot carry it, because the type has no
// such field. Only the hash is stored.
export const apiKeyCreatedSchema = apiKeySchema.extend({ secret: z.string().min(32) }).strict();

export const apiKeyListQuerySchema = paginationRequestSchema;

export type ApiKeyCreateRequest = z.infer<typeof apiKeyCreateRequestSchema>;
export type ApiKey = z.infer<typeof apiKeySchema>;
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;
