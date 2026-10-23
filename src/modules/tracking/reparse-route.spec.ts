import "reflect-metadata";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { AUDIT_METADATA_KEY, type AuditOptions } from "../../api/decorators/audit.decorator.js";
import { CREDITS_KEY } from "../../api/decorators/credits.decorator.js";
import { DAILY_CAP_KEY } from "../../api/decorators/daily-cap.decorator.js";
import { IDEMPOTENT_KEY } from "../../api/decorators/idempotent.decorator.js";
import { METER_KEY } from "../../api/decorators/meter.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { SCOPED_BY_QUERY_KEY } from "../../api/decorators/scoped-by-query.decorator.js";
import { ResultsController } from "./results.controller.js";

// STORY-034 AC9 - `POST /v1/results/{id}/reparse` is a customer route (FR-PA-08, owner decision 2026-10-23), permission-gated,
// free, idempotent and audited. These are the properties of the route that no service-level test can see.

describe("STORY-034 AC9 · the re-parse route", () => {
  const reflector = new Reflector();
  const handler = (ResultsController.prototype as unknown as Record<string, (...args: never[]) => unknown>).reparse!;

  it("034-RT1 · exists, requires tracking:trigger, and checks the row's own project scope", () => {
    expect(handler).toBeTypeOf("function");
    expect(reflector.get(REQUIRE_PERMISSION_KEY, handler)).toBe("tracking:trigger");
    expect(reflector.get(SCOPED_BY_QUERY_KEY, handler)).toBe(true);
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
