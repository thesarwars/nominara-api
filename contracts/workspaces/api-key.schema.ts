import { z } from "zod";
import { PERMISSIONS } from "../../src/tenancy/permission-matrix.js";

// NEW-D-4 — /v1/api-keys. api-specification.md §3: `GET`/`POST`/`DELETE`
// `/api-keys`, permission `apikey:create` (owner and admin, step-up), "secret
// returned once". schemas/identity-and-tenancy.md `api_keys`.
//
// DECISIONS:
//  - Hash scheme: sha256 of the full key (schemas/identity-and-tenancy.md,
//    security-and-tenancy.md §5). The key is `nk_live_` + 22 characters; the
//    first 12 characters are stored as `key_prefix` and shown in the UI.
//  - Create returns { key, secret } NESTED, like share tokens. The field is
//    `key`, not `api_key`: the audit redactor blanks any key matching
//    /api[_-]?key/, which would erase the whole audited response body.
//  - Revoke is DELETE and answers 200 with the ApiKey, idempotently (the
//    first revoked_at is kept) — the same shape as DELETE /share-tokens/{id}.
//  - ONLY createdApiKeySchema carries `secret`. ApiKey (list, revoke) has
//    neither the secret nor the hash.

/** `apikey:create` itself is never grantable to a key: a key must not mint keys. */
export const GRANTABLE_API_KEY_PERMISSIONS = PERMISSIONS.filter((p) => p !== "apikey:create");

export const apiKeyPermissionSchema = z.enum(GRANTABLE_API_KEY_PERMISSIONS as [string, ...string[]]);

export const apiKeySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** First 12 characters of the key, e.g. `nk_live_ab12` — the only key-derived value ever returned after creation. */
    key_prefix: z.string().length(12),
    permissions: z.array(z.string()),
    /** null = the key reaches every project its permissions allow. */
    project_scope: z.array(z.uuid()).nullable(),
    created_by: z.uuid(),
    last_used_at: z.iso.datetime().nullable(),
    expires_at: z.iso.datetime().nullable(),
    revoked_at: z.iso.datetime().nullable(),
    created_at: z.iso.datetime(),
  })
  .strict();
export type ApiKey = z.infer<typeof apiKeySchema>;

export const apiKeyListResponseSchema = z.array(apiKeySchema);
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;

export const createApiKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    permissions: z.array(apiKeyPermissionSchema).min(1).max(GRANTABLE_API_KEY_PERMISSIONS.length),
    project_scope: z.array(z.uuid()).min(1).nullable().default(null),
    expires_at: z.iso.datetime().nullable().default(null),
  })
  .strict();
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

export const createdApiKeySchema = z
  .object({
    key: apiKeySchema,
    /** `nk_live_{22 chars}`. Returned in this one response and never again. */
    secret: z.string().regex(/^nk_live_[A-Za-z0-9_-]{22}$/),
  })
  .strict();
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>;
