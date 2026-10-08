import "reflect-metadata";
import { createHash } from "node:crypto";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { PoolClient } from "pg";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { createApiKeyRequestSchema, createdApiKeySchema, apiKeySchema } from "../../../contracts/workspaces/api-key.schema.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { AuditInterceptor, type AuditableRequest } from "../../api/interceptors/audit.interceptor.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { API_KEY_PREFIX_LENGTH, generateApiKey, hashApiKey } from "./api-keys.service.js";
import type { AuditChainService } from "../audit/audit-chain.service.js";

describe("NEW-D-4 · API key secret helpers", () => {
  it("NEW-D-4 AC3 · a key is nk_live_ plus 22 characters, never repeated, and the stored prefix is its first 12", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const k = generateApiKey();
      expect(k).toMatch(/^nk_live_[A-Za-z0-9_-]{22}$/);
      seen.add(k);
    }
    expect(seen.size).toBe(200);
    expect(API_KEY_PREFIX_LENGTH).toBe(12);
  });

  it("NEW-D-4 AC3 · the stored hash is the 32-byte SHA-256 of the full key, and differs per key", () => {
    const a = hashApiKey("nk_live_" + "a".repeat(22));
    expect(a).toHaveLength(32);
    expect(a.equals(createHash("sha256").update("nk_live_" + "a".repeat(22)).digest())).toBe(true);
    expect(a.equals(hashApiKey("nk_live_" + "b".repeat(22)))).toBe(false);
  });
});

describe("NEW-D-4 · contract", () => {
  const valid = { name: "CI", permissions: ["project:read"] };

  it("NEW-D-4 AC3 · the create request is .strict(): an unknown key is rejected, never dropped", () => {
    expect(createApiKeyRequestSchema.safeParse(valid).success).toBe(true);
    expect(createApiKeyRequestSchema.safeParse({ ...valid, key_hash: "x" }).success).toBe(false);
  });

  it("NEW-D-4 AC1 · a key cannot be granted apikey:create, an unknown permission, or an empty permission set", () => {
    expect(createApiKeyRequestSchema.safeParse({ ...valid, permissions: ["apikey:create"] }).success).toBe(false);
    expect(createApiKeyRequestSchema.safeParse({ ...valid, permissions: ["nope:nope"] }).success).toBe(false);
    expect(createApiKeyRequestSchema.safeParse({ ...valid, permissions: [] }).success).toBe(false);
  });

  it("NEW-D-4 AC2 · only the create response schema can carry a secret; the list/revoke shape rejects one", () => {
    const key = {
      id: "0195e5b7-0000-7000-8000-000000000001",
      name: "CI",
      key_prefix: "nk_live_ab12",
      permissions: ["project:read"],
      project_scope: null,
      created_by: "0195e5b7-0000-7000-8000-000000000002",
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      created_at: "2026-10-07T00:00:00.000Z",
    };
    expect(apiKeySchema.safeParse(key).success).toBe(true);
    expect(apiKeySchema.safeParse({ ...key, secret: "nk_live_" + "a".repeat(22) }).success).toBe(false);
    expect(apiKeySchema.safeParse({ ...key, key_hash: "abc" }).success).toBe(false);
    expect(createdApiKeySchema.safeParse({ key, secret: "nk_live_" + "a".repeat(22) }).success).toBe(true);
  });
});

class Routes {
  @Audit({ action: "api_key.created", resourceType: "api_key", resourceIdFrom: "response", responseIdPath: "key.id", severity: "warning" })
  create(): void {}
}

describe("NEW-D-4 AC6 · @Audit({ severity }) reaches the audit row", () => {
  it("NEW-D-4 AC6 · the interceptor writes the severity the route declared", async () => {
    const append = vi.fn(() => Promise.resolve());
    const interceptor = new AuditInterceptor(new Reflector(), { append } as unknown as AuditChainService);
    const req: Partial<AuditableRequest> = { method: "POST", id: "r1", headers: {}, params: {}, authMethod: "session" };
    const ctx = {
      getHandler: () => (Routes.prototype as unknown as Record<string, () => void>).create,
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of({ key: { id: "0195e5b7-0000-7000-8000-000000000001" } }) };
    const client = { query: vi.fn(() => Promise.resolve({ rows: [] })) } as unknown as PoolClient;
    await withTenantContext(client, { workspaceId: "ws-1", actorId: "u-1" }, async () => {
      await firstValueFrom(interceptor.intercept(ctx, next));
    });
    const [, input] = append.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(input).toMatchObject({ action: "api_key.created", severity: "warning", resourceId: "0195e5b7-0000-7000-8000-000000000001" });
  });
});

describe("NEW-D-4 audit · grantable permissions", () => {
  it("NEW-D-4 audit · no step-up-gated permission is in the published grantable set", async () => {
    const { PERMISSION_MATRIX, ROLES } = await import("../../tenancy/permission-matrix.js");
    const { GRANTABLE_API_KEY_PERMISSIONS } = await import("../../../contracts/workspaces/api-key.schema.js");
    for (const p of GRANTABLE_API_KEY_PERMISSIONS) {
      for (const r of ROLES) expect(PERMISSION_MATRIX[p as keyof typeof PERMISSION_MATRIX][r].stepUp, `${p} held by ${r}`).toBe(false);
    }
  });
});

describe("NEW-D-4 audit · a key never exceeds its creator's role", () => {
  it("NEW-D-4 audit · the service refuses a permission the caller's role is denied, before touching the database", async () => {
    const { ApiKeysService } = await import("./api-keys.service.js");
    const svc = new ApiKeysService();
    const body = { name: "k", permissions: ["member:update_role"], project_scope: null, expires_at: null };
    await expect(svc.create("analyst", body)).rejects.toMatchObject({ response: { details: { required_permission: "member:update_role" } } });
    await expect(svc.create("not-a-role", body)).rejects.toMatchObject({ response: { details: { required_permission: "member:update_role" } } });
  });
});
