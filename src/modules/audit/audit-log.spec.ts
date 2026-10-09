import { describe, expect, it } from "vitest";
import { auditLogEntrySchema } from "../../../contracts/trust/index.js";
import { categoryOf, categoryPredicate, dayAfter, toAuditLogEntry } from "./audit-log.service.js";

// NEW-D-3 — pure parts of GET /v1/audit-log. The query path itself is covered
// against real Postgres in test/integration/audit-log-http.spec.ts.
describe("NEW-D-3 · audit-log category derivation (owner decision: from the action namespace)", () => {
  it("AC-category: auth.*, apikey.*, support.* are security", () => {
    expect(categoryOf("auth.login")).toBe("security");
    expect(categoryOf("apikey.create")).toBe("security");
    expect(categoryOf("support.grant")).toBe("security");
  });
  it("AC-category: billing.* is billing; workspace.* and member.* are workspace", () => {
    expect(categoryOf("billing.addon.create")).toBe("billing");
    expect(categoryOf("workspace.create")).toBe("workspace");
    expect(categoryOf("member.invite")).toBe("workspace");
  });
  it("AC-category: an unmapped namespace lands in data rather than being dropped", () => {
    expect(categoryOf("project.create")).toBe("data");
    expect(categoryOf("zzz.unknown")).toBe("data");
    expect(categoryOf("nodot")).toBe("data");
  });
  it("AC-category: a namespace is matched whole, not as a string prefix (billingx.* is not billing)", () => {
    expect(categoryOf("billingx.thing")).toBe("data");
    expect(categoryOf("authz.thing")).toBe("data");
  });
  it("AC-category: the SQL predicate partitions the same way (data = the complement)", () => {
    expect(categoryPredicate("billing")).toEqual({ include: ["billing."] });
    expect(categoryPredicate("security")).toEqual({ include: ["auth.", "apikey.", "support."] });
    expect(categoryPredicate("data").include).toBeUndefined();
    expect(categoryPredicate("data").exclude).toEqual(["auth.", "apikey.", "support.", "billing.", "workspace.", "member."]);
  });
});

describe("NEW-D-3 · date range and entry shape", () => {
  it("AC-range: `to` is inclusive of the whole day — the exclusive bound is the next UTC midnight", () => {
    expect(dayAfter("2026-09-16")).toBe("2026-09-17T00:00:00.000Z");
    expect(dayAfter("2026-12-31")).toBe("2027-01-01T00:00:00.000Z");
  });
  it("AC-range: a calendar-impossible date is a validation error, not NaN reaching SQL", () => {
    expect(() => dayAfter("2026-02-31")).toThrow();
  });
  it("AC-redaction: an entry's id is the row seq, and no hash appears as a field or a value, and no state is exposed", () => {
    const entry = toAuditLogEntry({
      seq: "7",
      workspace_id: "11111111-1111-4111-8111-111111111111",
      occurred_at: "2026-09-16T10:00:00.123Z",
      actor_type: "system",
      actor_id: null,
      actor_ip: "10.0.0.1",
      actor_ua: "ua",
      action: "billing.addon.create",
      resource_type: "addon",
      resource_id: null,
      before_state: { secret: 1 },
      after_state: { secret: 2 },
      request_id: "req-1",
      support_grant_id: null,
      severity: "info",
      prev_hash: Buffer.alloc(32, 1),
      row_hash: Buffer.alloc(32, 0xab),
    });
    expect(auditLogEntrySchema.parse(entry)).toEqual(entry);
    expect(entry.id).toBe("7");
    expect(JSON.stringify(entry)).not.toContain("ab".repeat(32));
    expect(JSON.stringify(entry)).not.toContain("01".repeat(32));
    expect(entry.category).toBe("billing");
    expect(Object.keys(entry)).not.toEqual(expect.arrayContaining(["prev_hash"]));
    expect(JSON.stringify(entry)).not.toMatch(/secret|prev_hash|row_hash|before_state|after_state|actor_ip|10\.0\.0\.1/u);
  });
});
