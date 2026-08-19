import "reflect-metadata";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { PoolClient } from "pg";
import { firstValueFrom, of, throwError } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { AuditMetadataMissingError, AuditResourceIdUnresolvedError } from "../../tenancy/errors.js";
import type { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { Audit } from "../decorators/audit.decorator.js";
import { Public } from "../decorators/public.decorator.js";
import { SkipTenantContext } from "../decorators/skip-tenant-context.decorator.js";
import { AuditInterceptor, type AuditableRequest } from "./audit.interceptor.js";

class ProjectController {
  @Audit({ action: "project.update", resourceType: "project" })
  update(): void {}

  @Audit({ action: "project.create", resourceType: "project", resourceIdFrom: "response" })
  create(): void {}

  @Audit({ action: "project.update.alt", resourceType: "project", paramName: "projectId" })
  updateWithAltParam(): void {}

  unannotatedMutation(): void {}

  @Audit({ action: "project.read_ignored", resourceType: "project" })
  read(): void {}

  @Public()
  publicMutation(): void {}

  @SkipTenantContext()
  tenantLessMutation(): void {}
}

function makeContext(method: keyof ProjectController, req: Partial<AuditableRequest>): ExecutionContext {
  const proto = ProjectController.prototype as unknown as Record<string, () => void>;
  return {
    getHandler: () => proto[method],
    getClass: () => ProjectController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

function fakeAuditChain(appendImpl: (...args: unknown[]) => Promise<void> = () => Promise.resolve()) {
  return { append: vi.fn(appendImpl) } as unknown as AuditChainService;
}

function fakePoolClient() {
  const queries: unknown[][] = [];
  const client = {
    query: vi.fn((...args: unknown[]) => {
      queries.push(args);
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as PoolClient;
  return { client, queries };
}

describe("STORY-020 · AuditInterceptor", () => {
  it("scenario 1 — a mutating route with @Audit() metadata writes a row with action, resource, actor and request id", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();

    const req: Partial<AuditableRequest> = {
      method: "PUT",
      id: "req-42",
      headers: { "user-agent": "vitest-ua" },
      params: { id: "11111111-1111-1111-1111-111111111111" },
      ip: "203.0.113.9",
      authMethod: "session",
    };
    const next: CallHandler = { handle: () => of({ ok: true }) };

    await withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () => {
      const result$ = interceptor.intercept(makeContext("update", req), next);
      await expect(firstValueFrom(result$)).resolves.toEqual({ ok: true });
    });

    expect(auditChain.append).toHaveBeenCalledOnce();
    const [, input] = (auditChain.append as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input).toMatchObject({
      workspaceId: "ws-1",
      actorType: "user",
      actorId: "user-1",
      actorIp: "203.0.113.9",
      actorUa: "vitest-ua",
      action: "project.update",
      resourceType: "project",
      resourceId: "11111111-1111-1111-1111-111111111111",
      requestId: "req-42",
      supportGrantId: null,
      severity: "info",
    });
  });

  it("resourceIdFrom: 'response' reads resource_id from the handler's returned body, not the route params", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = { method: "POST", id: "req-1", headers: {}, authMethod: "session" };
    const next: CallHandler = { handle: () => of({ id: "22222222-2222-2222-2222-222222222222" }) };

    await withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () => {
      await firstValueFrom(interceptor.intercept(makeContext("create", req), next));
    });

    const [, input] = (auditChain.append as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.resourceId).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("skips non-mutating methods entirely — GET never calls append, even with @Audit() present", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const req: Partial<AuditableRequest> = { method: "GET", id: "req-1", headers: {} };
    const next: CallHandler = { handle: () => of({ ok: true }) };

    const result$ = interceptor.intercept(makeContext("read", req), next);
    await expect(firstValueFrom(result$)).resolves.toEqual({ ok: true });
    expect(auditChain.append).not.toHaveBeenCalled();
  });

  it("fails closed — a mutating route with no @Audit() metadata throws before the handler ever runs", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const handle = vi.fn(() => of("unreachable"));
    const req: Partial<AuditableRequest> = { method: "DELETE", id: "req-1", headers: {} };

    expect(() => interceptor.intercept(makeContext("unannotatedMutation", req), { handle })).toThrow(
      AuditMetadataMissingError,
    );
    expect(handle).not.toHaveBeenCalled();
    expect(auditChain.append).not.toHaveBeenCalled();
  });

  it("scenario 2 — when the audit write fails, the mutation's transaction rolls back too", async () => {
    const auditChain = fakeAuditChain(() => Promise.reject(new Error("audit db down")));
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client, queries } = fakePoolClient();
    const req: Partial<AuditableRequest> = { method: "PUT", id: "req-1", headers: {}, params: { id: "44444444-4444-4444-4444-444444444444" } };

    await expect(
      withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () =>
        firstValueFrom(interceptor.intercept(makeContext("update", req), { handle: () => of({ ok: true }) })),
      ),
    ).rejects.toThrow("audit db down");

    expect(queries.at(-1)?.[0]).toBe("ROLLBACK");
    expect(queries.some((q) => q[0] === "COMMIT")).toBe(false);
  });

  it("a support action records actor_type='support' and the grant reference", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = {
      method: "PUT",
      id: "req-1",
      headers: {},
      params: { id: "33333333-3333-3333-3333-333333333333" },
      supportGrant: { id: "grant-1" },
    };

    await withTenantContext(client, { workspaceId: "ws-1", actorId: "support-engineer-1" }, async () => {
      await firstValueFrom(interceptor.intercept(makeContext("update", req), { handle: () => of({ ok: true }) }));
    });

    const [, input] = (auditChain.append as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.actorType).toBe("support");
    expect(input.supportGrantId).toBe("grant-1");
  });

  it("throws AuditMetadataMissingError if no tenant context store is active (interceptor ordering violated)", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const req: Partial<AuditableRequest> = { method: "PUT", id: "req-1", headers: {}, params: { id: "44444444-4444-4444-4444-444444444444" } };

    await expect(
      firstValueFrom(interceptor.intercept(makeContext("update", req), { handle: () => of({ ok: true }) })),
    ).rejects.toThrow(AuditMetadataMissingError);
  });

  it("api-key auth is recorded as actor_type='api_key'", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = {
      method: "PUT",
      id: "req-1",
      headers: {},
      params: { id: "44444444-4444-4444-4444-444444444444" },
      authMethod: "apiKey",
    };

    await withTenantContext(client, { workspaceId: "ws-1", actorId: "key-1" }, async () => {
      await firstValueFrom(interceptor.intercept(makeContext("update", req), { handle: () => of({ ok: true }) }));
    });

    const [, input] = (auditChain.append as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.actorType).toBe("api_key");
  });

  it("propagates a handler error without ever calling append (no response to audit)", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = { method: "PUT", id: "req-1", headers: {}, params: { id: "44444444-4444-4444-4444-444444444444" } };
    const next: CallHandler = { handle: () => throwError(() => new Error("handler exploded")) };

    await expect(
      withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () =>
        firstValueFrom(interceptor.intercept(makeContext("update", req), next)),
      ),
    ).rejects.toThrow("handler exploded");
    expect(auditChain.append).not.toHaveBeenCalled();
  });

  it("a @Public() mutating route is exempt — no @Audit() required, no append, no tenant context needed", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const req: Partial<AuditableRequest> = { method: "POST", id: "req-1", headers: {} };
    const next: CallHandler = { handle: () => of({ ok: true }) };

    const result$ = interceptor.intercept(makeContext("publicMutation", req), next);
    await expect(firstValueFrom(result$)).resolves.toEqual({ ok: true });
    expect(auditChain.append).not.toHaveBeenCalled();
  });

  it("a @SkipTenantContext() mutating route is exempt — no @Audit() required, no append, no tenant context needed", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const req: Partial<AuditableRequest> = { method: "PATCH", id: "req-1", headers: {} };
    const next: CallHandler = { handle: () => of({ ok: true }) };

    const result$ = interceptor.intercept(makeContext("tenantLessMutation", req), next);
    await expect(firstValueFrom(result$)).resolves.toEqual({ ok: true });
    expect(auditChain.append).not.toHaveBeenCalled();
  });

  // qa-reviewer blocking finding 2 — resourceIdFromParams used to hardcode
  // req.params.id and silently write null for any other param name, and a
  // non-UUID value crashed AuditChainService.append with a raw Postgres
  // 22P02 error. Both are now a loud, attributable AuditResourceIdUnresolvedError
  // instead.
  it("fails closed — @Audit() default paramName ('id') absent from req.params writes no null resource_id, throws instead", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = {
      method: "PUT",
      id: "req-1",
      headers: {},
      params: { otherName: "44444444-4444-4444-4444-444444444444" },
    };

    await expect(
      withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () =>
        firstValueFrom(interceptor.intercept(makeContext("update", req), { handle: () => of({ ok: true }) })),
      ),
    ).rejects.toThrow(AuditResourceIdUnresolvedError);
    expect(auditChain.append).not.toHaveBeenCalled();
  });

  it("fails closed — a non-UUID params value is rejected before it ever reaches AuditChainService.append", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = {
      method: "PUT",
      id: "req-1",
      headers: {},
      params: { id: "not-a-uuid" },
    };

    const rejection = withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () =>
      firstValueFrom(interceptor.intercept(makeContext("update", req), { handle: () => of({ ok: true }) })),
    );
    await expect(rejection).rejects.toThrow(AuditResourceIdUnresolvedError);
    expect(auditChain.append).not.toHaveBeenCalled();

    // Post-review should-fix #2: the raw, attacker-controlled param value
    // must never appear in the error message — Nest's default
    // ExceptionsHandler logs it server-side regardless of what ProblemFilter
    // does with the HTTP response.
    const error = (await rejection.catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("not-a-uuid");
  });

  it("fails closed — a non-UUID response '.id' is rejected the same way as a non-UUID params value", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = { method: "POST", id: "req-1", headers: {} };
    const next: CallHandler = { handle: () => of({ id: "not-a-uuid" }) };

    const rejection = withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () =>
      firstValueFrom(interceptor.intercept(makeContext("create", req), next)),
    );
    await expect(rejection).rejects.toThrow(AuditResourceIdUnresolvedError);
    expect(auditChain.append).not.toHaveBeenCalled();

    const error = (await rejection.catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("not-a-uuid");
  });

  it("paramName lets a route read resource_id from a param named something other than 'id'", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = {
      method: "PUT",
      id: "req-1",
      headers: {},
      params: { projectId: "55555555-5555-5555-5555-555555555555" },
    };

    await withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () => {
      await firstValueFrom(interceptor.intercept(makeContext("updateWithAltParam", req), { handle: () => of({ ok: true }) }));
    });

    const [, input] = (auditChain.append as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.resourceId).toBe("55555555-5555-5555-5555-555555555555");
  });
});
