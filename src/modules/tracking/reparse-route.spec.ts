import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { AUDIT_METADATA_KEY, type AuditOptions } from "../../api/decorators/audit.decorator.js";
import { CREDITS_KEY } from "../../api/decorators/credits.decorator.js";
import { DAILY_CAP_KEY } from "../../api/decorators/daily-cap.decorator.js";
import { IDEMPOTENT_KEY } from "../../api/decorators/idempotent.decorator.js";
import { METER_KEY } from "../../api/decorators/meter.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { SCOPED_BY_QUERY_KEY } from "../../api/decorators/scoped-by-query.decorator.js";
import { PermissionDeniedException } from "../../tenancy/errors.js";
import { ReparseGuard, type ReparseRequest } from "./reparse.guard.js";
import type { ReparseService, ReparseSource } from "./reparse.service.js";
import { ResultsController } from "./results.controller.js";

// STORY-034 AC9 - `POST /v1/results/{id}/reparse` is a customer route (FR-PA-08, owner decision 2026-10-23), permission-gated,
// free, idempotent and audited. These are the properties of the route that no service-level test can see.

describe("STORY-034 AC9 · the re-parse route", () => {
  const reflector = new Reflector();
  const handler = (ResultsController.prototype as unknown as Record<string, (...args: never[]) => unknown>).reparse!;

  it("034-RT1 · exists, requires tracking:trigger AND the owner/admin ReparseGuard, and checks the row's own project scope", () => {
    expect(handler).toBeTypeOf("function");
    expect(reflector.get(REQUIRE_PERMISSION_KEY, handler)).toBe("tracking:trigger");
    expect(reflector.get(SCOPED_BY_QUERY_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([ReparseGuard]);
  });

  // THE OWNER DECISION (2026-10-23): only owners and admins may re-parse. `tracking:trigger` admits a scoped manager, so the guard is the gate.
  describe("034-RT1 · ReparseGuard: owners and admins only", () => {
    const SOURCE: ReparseSource = { objectKey: "k", body: { text: "t" } };
    const run = async (role: string | undefined, scope: readonly string[] | null = null) => {
      const prefetchSource = vi.fn().mockResolvedValue(SOURCE);
      const guard = new ReparseGuard({ prefetchSource } as unknown as ReparseService);
      const req: ReparseRequest = {
        params: { id: "01a06ccd-9e37-7f0c-957b-195fa6d263dd" },
        tenant: { workspaceId: "ws-1", actorId: "u-1" },
        ...(role !== undefined ? { membership: { role, projectScope: scope } } : {}),
      } as ReparseRequest;
      const context = { switchToHttp: () => ({ getRequest: () => req }) } as never;
      return { req, prefetchSource, result: guard.canActivate(context) };
    };

    it.each(["owner", "admin"])("%s is allowed, and the raw object is prefetched for the caller's own tenant", async (role) => {
      const { req, prefetchSource, result } = await run(role);
      await expect(result).resolves.toBe(true);
      expect(prefetchSource).toHaveBeenCalledWith({ workspaceId: "ws-1", actorId: "u-1" }, "01a06ccd-9e37-7f0c-957b-195fa6d263dd");
      expect(req.reparseSource).toBe(SOURCE);
    });

    it.each([
      ["manager scoped to a project", "manager", ["p-1"]],
      ["manager with no scope restriction", "manager", null],
      ["analyst", "analyst", null],
      ["viewer", "viewer", null],
      ["an unknown role", "janitor", null],
    ] as const)("%s is refused with a 403 naming the permission, and NO object is read", async (_label, role, scope) => {
      const { prefetchSource, result } = await run(role, scope);
      await expect(result).rejects.toBeInstanceOf(PermissionDeniedException);
      await expect(result).rejects.toMatchObject({ response: { details: { required_permission: "tracking:trigger" } } });
      expect(prefetchSource).not.toHaveBeenCalled();
    });

    it("a request with no membership at all (an API key) is refused, never defaulted to allowed", async () => {
      const { prefetchSource, result } = await run(undefined);
      await expect(result).rejects.toBeInstanceOf(PermissionDeniedException);
      expect(prefetchSource).not.toHaveBeenCalled();
    });
  });

  it("034-RT2 · is FREE: not credit-guarded, not metered, not daily-capped", () => {
    expect(reflector.get(CREDITS_KEY, handler)).toBeUndefined();
    expect(reflector.get(METER_KEY, handler)).toBeUndefined();
    expect(reflector.get(DAILY_CAP_KEY, handler)).toBeUndefined();
  });

  it("034-RT3 · requires an Idempotency-Key, declared in the contract too", () => {
    expect(reflector.get(IDEMPOTENT_KEY, handler)).toBe(true);
    expect(reflector.get(API_CONTRACT_KEY, handler)).toMatchObject({ operationId: "reparseResult", requiresIdempotencyKey: true });
  });

  it("034-RT4 · is audited, and the audit row records the outcome only - never the entity labels or any answer text", () => {
    const audit = reflector.get<AuditOptions>(AUDIT_METADATA_KEY, handler);
    expect(audit).toMatchObject({ action: "result.reparsed", resourceType: "result" });
    const recorded = audit.afterState!({
      result_id: "01a06ccd-9e37-7f0c-957b-195fa6d263dd",
      scoring_version: "v1",
      changed: true,
      credits_charged: 0,
      before: { entities: [{ label: "Acme Secret Competitor" }] },
      after: { entities: [{ label: "Acme Secret Competitor" }] },
    });
    expect(recorded).toEqual({ result_id: "01a06ccd-9e37-7f0c-957b-195fa6d263dd", scoring_version: "v1", changed: true, credits_charged: 0 });
    expect(JSON.stringify(recorded)).not.toContain("Acme");
  });
});

describe("STORY-034 AC7 · the results list route", () => {
  const reflector = new Reflector();
  it("034-RT5 · is tracking:read, project-scoped by the path, and a cursor list", async () => {
    const { ResultsListController } = await import("./results-list.controller.js");
    const handler = (ResultsListController.prototype as unknown as Record<string, (...args: never[]) => unknown>).list!;
    expect(reflector.get(REQUIRE_PERMISSION_KEY, handler)).toBe("tracking:read");
    expect(reflector.get(API_CONTRACT_KEY, handler)).toMatchObject({ operationId: "listProjectResults", listOf: true });
  });
});
