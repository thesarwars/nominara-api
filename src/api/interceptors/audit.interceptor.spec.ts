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
import { Streaming } from "../decorators/streaming.decorator.js";
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

  @Audit({ action: "billing.portal_session.created", resourceType: "workspace", resourceIdFrom: "workspace" })
  workspaceSingleton(): void {}

  @Audit({
    action: "command.parsed",
    resourceType: "workspace",
    resourceIdFrom: "workspace",
    afterState: (body) => ({ intent: (body as { intent: string }).intent }),
  })
  selectiveState(): void {}

  @Audit({
    action: "task.completed",
    actionFrom: (body) => ((body as { status: string }).status === "in_review" ? "task.verification_submitted" : "task.completed"),
    resourceType: "task",
  })
  actionFromResponse(): void {}

  unannotatedMutation(): void {}

  @Streaming()
  streamingMutation(): void {}

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

  // THE LIVE GAP. POST /v1/projects returns `project_id` — §4.4 names the
  // field, so the contract generates it — and this used to resolve null,
  // throw, and answer 500 AFTER the project row had been written. A caller
  // saw a failure for a project that exists.
  it("resolves <resourceType>_id from the response when there is no bare 'id'", async () => {
    const projectId = "0195e5b7-0000-7000-8000-000000000001";
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = {
      method: "POST",
      id: "req-1",
      headers: { "user-agent": "vitest-ua" },
      params: {},
      ip: "203.0.113.9",
      authMethod: "session",
    };
    const next: CallHandler = { handle: () => of({ project_id: projectId, root_url: "https://hubspot.com" }) };

    await withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () => {
      await firstValueFrom(interceptor.intercept(makeContext("create", req), next));
    });

    const [, input] = (auditChain.append as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input).toMatchObject({ action: "project.create", resourceId: projectId });
  });

  it("prefers a bare 'id' when a response carries both", async () => {
    const bare = "0195e5b7-0000-7000-8000-0000000000aa";
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = {
      method: "POST",
      id: "req-1",
      headers: { "user-agent": "vitest-ua" },
      params: {},
      ip: "203.0.113.9",
      authMethod: "session",
    };
    const next: CallHandler = { handle: () => of({ id: bare, project_id: "0195e5b7-0000-7000-8000-0000000000bb" }) };

    await withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () => {
      await firstValueFrom(interceptor.intercept(makeContext("create", req), next));
    });

    const [, input] = (auditChain.append as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input).toMatchObject({ resourceId: bare });
  });

  it("does not accept some OTHER resource's id field", async () => {
    // `invitation_id` on a route auditing a project is not this project's id,
    // and treating any *_id as the subject would attribute an audit row to the
    // wrong resource — worse than failing.
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = {
      method: "POST",
      id: "req-1",
      headers: { "user-agent": "vitest-ua" },
      params: {},
      ip: "203.0.113.9",
      authMethod: "session",
    };
    const next: CallHandler = { handle: () => of({ invitation_id: "0195e5b7-0000-7000-8000-0000000000cc" }) };

    await withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () => {
      await expect(firstValueFrom(interceptor.intercept(makeContext("create", req), next))).rejects.toThrow();
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

  // STORY-079 - a streaming route holds no ambient transaction (see streaming.decorator.ts), so there is no store to append to and no response body to name
  // a resource from. Like the three interceptors the marker already exempts, this one steps aside; the route's own service writes its audit row in the
  // transaction it opens (visibility-scan.service.ts).
  it("STORY-079 - a @Streaming() mutating route is not run through the interceptor: no throw, no row", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const handle = vi.fn(() => of("streamed"));
    const req: Partial<AuditableRequest> = { method: "POST", id: "req-1", headers: {} };
    const result$ = interceptor.intercept(makeContext("streamingMutation", req), { handle });
    await expect(firstValueFrom(result$)).resolves.toBe("streamed");
    expect(handle).toHaveBeenCalledTimes(1);
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

  // STORY-075a — a workspace-singleton mutation (a billing-portal session) has
  // no id in its params or its response. The resource IS the caller's
  // workspace, and the id comes from the tenant context, never the request.
  it("resourceIdFrom: 'workspace' audits against the tenant's workspace id, ignoring any params the caller sent", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = { method: "POST", id: "req-1", headers: {}, params: { id: "99999999-9999-9999-9999-999999999999" } };

    await withTenantContext(client, { workspaceId: "11111111-2222-3333-4444-555555555555", actorId: "user-1" }, async () => {
      await firstValueFrom(interceptor.intercept(makeContext("workspaceSingleton", req), { handle: () => of({ ok: true }) }));
    });

    const [, input] = (auditChain.append as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.resourceId).toBe("11111111-2222-3333-4444-555555555555");
    expect(input.resourceType).toBe("workspace");
  });
});

describe("STORY-085-A CP2 · AuditOptions.afterState", () => {
  const req: Partial<AuditableRequest> = {
    method: "POST",
    id: "req-9",
    headers: { "user-agent": "vitest-ua" },
    params: {},
    ip: "203.0.113.9",
    authMethod: "session",
  };

  it("records what the selector returns, not the response body", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const body = { intent: "invite_member", slots: { email: "jo@acme.io" } };
    await withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () => {
      await expect(firstValueFrom(interceptor.intercept(makeContext("selectiveState", req), { handle: () => of(body) }))).resolves.toBe(body);
    });
    const [, input] = (auditChain.append as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.afterState).toEqual({ intent: "invite_member" });
  });

  it("without a selector the full body is still recorded (no behaviour change for other routes)", async () => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    await withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () => {
      await firstValueFrom(interceptor.intercept(makeContext("update", { ...req, method: "PUT", params: { id: "11111111-1111-1111-1111-111111111111" } }), { handle: () => of({ ok: true }) }));
    });
    const [, input] = (auditChain.append as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.afterState).toEqual({ ok: true });
  });

  // STORY-055 review r3 — one route, two outcomes: the action name may be chosen from the response.
  it.each([
    ["in_review", "task.verification_submitted"],
    ["done", "task.completed"],
  ])("actionFrom picks the audit action from the response (%s -> %s)", async (status, action) => {
    const auditChain = fakeAuditChain();
    const interceptor = new AuditInterceptor(new Reflector(), auditChain);
    const { client } = fakePoolClient();
    const req: Partial<AuditableRequest> = { method: "POST", id: "r", headers: {}, params: { id: "11111111-1111-1111-1111-111111111111" }, authMethod: "session" };
    await withTenantContext(client, { workspaceId: "ws-1", actorId: "user-1" }, async () => {
      await firstValueFrom(interceptor.intercept(makeContext("actionFromResponse", req), { handle: () => of({ status }) }));
    });
    const [, input] = (auditChain.append as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input).toMatchObject({ action });
  });
});
