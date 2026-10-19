import { describe, expect, it, vi } from "vitest";
import { DomainVerificationService } from "./domain-verification.service.js";
import { DomainError } from "../../api/errors/domain-errors.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import type { CheckDeps } from "../../lib/verification/checkers.js";
import { TXT_PREFIX } from "../../lib/verification/checkers.js";

// STORY-048 scenarios 1, 7, 10, 11 and the state machine around them.

const PROJECT = "0f9e2a7c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const WS = "11111111-1111-7111-8111-111111111111";

interface Recorded {
  sql: string;
  params: unknown[];
}

describe("STORY-048 · DomainVerificationService", () => {
  let calls: Recorded[];
  let rowStore: Record<string, unknown>[];

  function harness(
    deps: Partial<CheckDeps> = {},
    existingRows: Record<string, unknown>[] = [],
    aggregateVerifiedAt: Date | null = null,
  ) {
    calls = [];
    rowStore = existingRows;
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          if (sql.includes("SELECT workspace_id, root_domain")) {
            return { rows: [{ workspace_id: WS, root_domain: "hubspot.com" }] };
          }
          // Before the generic read below: the aggregate also reads `FROM domain_verifications WHERE project_id`.
          if (sql.includes("max(verified_at)")) return { rows: [{ verified_at: aggregateVerifiedAt }] };
          if (sql.includes("FROM domain_verifications WHERE project_id")) return { rows: rowStore };
          if (sql.includes("INSERT INTO domain_verifications")) {
            const row = {
              id: params[0],
              domain: params[3],
              method: params[4],
              nonce: params[5],
              verified_at: null,
              last_checked_at: null,
              failure_reason: null,
            };
            return { rows: [row] };
          }
          if (sql.includes("UPDATE domain_verifications")) {
            return {
              rows: [{ ...rowStore[0], verified_at: params[1], failure_reason: params[2], last_checked_at: new Date() }],
            };
          }
          return { rows: [] };
        }),
      },
    } as never);

    const checks: CheckDeps = {
      resolveTxt: vi.fn(async () => []),
      fetch: vi.fn(async () => ({ status: 404, headers: {}, body: Buffer.from(""), finalUrl: "" })),
      ...deps,
    };
    return new DomainVerificationService(checks);
  }

  // AC1/AC2 — scenario 1.
  it.each(["dns_txt", "well_known_file", "meta_tag"] as const)(
    "scenario 1 — starting %s returns a nonce and instructions a customer can act on",
    async (method) => {
      const state = await harness().start(PROJECT, method);

      expect(state.method).toBe(method);
      expect(state.nonce.length).toBeGreaterThan(15);
      expect(state.verified).toBe(false);
      expect(state.instructions).toContain(state.nonce);
      expect(state.instructions.length).toBeGreaterThan(40);
    },
  );

  it("the instructions name the actual place to put the proof", async () => {
    const dns = await harness().start(PROJECT, "dns_txt");
    expect(dns.instructions).toContain("_nominara-verify.hubspot.com");

    const file = await harness().start(PROJECT, "well_known_file");
    expect(file.instructions).toContain("/.well-known/nominara-");
    // Scenario 5's rule, said up front rather than discovered by failing.
    expect(file.instructions).toContain("redirect");
  });

  // AC3 — rotating would silently invalidate a record the customer already
  // published, and they would have no way to tell why it stopped working.
  it("starting twice returns the SAME nonce rather than rotating it", async () => {
    const existing = {
      id: "v1",
      domain: "hubspot.com",
      method: "dns_txt",
      nonce: "already-issued",
      verified_at: null,
      last_checked_at: null,
      failure_reason: null,
    };
    const state = await harness({}, [existing]).start(PROJECT, "dns_txt");

    expect(state.nonce).toBe("already-issued");
    expect(calls.some((c) => c.sql.includes("INSERT INTO domain_verifications"))).toBe(false);
  });

  // AC8 / scenario 7 — the nonce is per domain, enforced by the row being
  // keyed on it. A nonce issued for one domain is simply not found for another.
  it("scenario 7 — a nonce does not transfer: lookups are keyed by project AND domain", async () => {
    await harness().start(PROJECT, "dns_txt");
    const select = calls.find((c) => c.sql.includes("FROM domain_verifications WHERE project_id"))!;
    expect(select.params).toContain("hubspot.com");
  });

  it("records the failure reason and leaves the domain unverified", async () => {
    const existing = {
      id: "v1", domain: "hubspot.com", method: "dns_txt", nonce: "n1",
      verified_at: null, last_checked_at: null, failure_reason: null,
    };
    const state = await harness({ resolveTxt: vi.fn(async () => [["v=spf1"]]) }, [existing]).check(PROJECT, "dns_txt");

    expect(state.verified).toBe(false);
    expect(state.failure_reason).toBe("record_present_but_wrong");
  });

  it("records success and clears the failure reason", async () => {
    const existing = {
      id: "v1", domain: "hubspot.com", method: "dns_txt", nonce: "n1",
      verified_at: null, last_checked_at: null, failure_reason: "record_absent",
    };
    const state = await harness({ resolveTxt: vi.fn(async () => [[`${TXT_PREFIX}n1`]]) }, [existing]).check(
      PROJECT,
      "dns_txt",
    );

    expect(state.verified).toBe(true);
    expect(state.failure_reason).toBeNull();
  });

  // AC7 / scenario 10 — the real case is a customer removing a record during
  // unrelated DNS work.
  it("scenario 10 — a domain that STOPS verifying loses scope and is notified", async () => {
    const verified = {
      id: "v1", domain: "hubspot.com", method: "dns_txt", nonce: "n1",
      verified_at: new Date("2026-09-01"), last_checked_at: new Date("2026-09-01"), failure_reason: null,
    };
    const state = await harness({ resolveTxt: vi.fn(async () => { throw new Error("ENOTFOUND"); }) }, [verified]).check(
      PROJECT,
      "dns_txt",
    );

    // Cleared, not left standing — full scope must not survive on evidence
    // that no longer holds.
    expect(state.verified).toBe(false);
    const notify = calls.find((c) => c.sql.includes("INSERT INTO notifications"));
    expect(notify, "losing verification must notify, not silently downgrade").toBeDefined();
    expect(notify!.sql).toContain("domain.verification_lost");
  });

  // STORY-048 AC7 — the notification says audits are limited to public-surface scope. That is only true when NO method
  // still verifies the domain; telling a customer they lost scope they still have is a false alarm.
  it("AC7 — does NOT claim scope was lost when another method still verifies the domain", async () => {
    const verified = {
      id: "v1", domain: "hubspot.com", method: "dns_txt", nonce: "n1",
      verified_at: new Date("2026-09-01"), last_checked_at: new Date("2026-09-01"), failure_reason: null,
    };
    const stillVerifiedByFile = new Date("2026-09-02");
    await harness({ resolveTxt: vi.fn(async () => { throw new Error("ENOTFOUND"); }) }, [verified], stillVerifiedByFile).check(
      PROJECT,
      "dns_txt",
    );
    expect(calls.some((c) => c.sql.includes("INSERT INTO notifications"))).toBe(false);
  });

  // A check that fails twice must not notify twice.
  it("does NOT notify when a check fails on a domain that was never verified", async () => {
    const neverVerified = {
      id: "v1", domain: "hubspot.com", method: "dns_txt", nonce: "n1",
      verified_at: null, last_checked_at: new Date(), failure_reason: "record_absent",
    };
    await harness({ resolveTxt: vi.fn(async () => { throw new Error("ENOTFOUND"); }) }, [neverVerified]).check(
      PROJECT,
      "dns_txt",
    );
    expect(calls.some((c) => c.sql.includes("INSERT INTO notifications"))).toBe(false);
  });

  it("mirrors the verified state onto the project row for the audit tool to read", async () => {
    const existing = {
      id: "v1", domain: "hubspot.com", method: "dns_txt", nonce: "n1",
      verified_at: null, last_checked_at: null, failure_reason: null,
    };
    await harness({ resolveTxt: vi.fn(async () => [[`${TXT_PREFIX}n1`]]) }, [existing]).check(PROJECT, "dns_txt");
    expect(calls.some((c) => c.sql.includes("SET domain_verified_at"))).toBe(true);
  });

  it("refuses a check for a method that was never started", async () => {
    const error = await harness().check(PROJECT, "meta_tag").catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("validation_failed");
  });

  // AC6 / scenarios 8 and 9 — the scope the audit tool will read.
  it("scenario 8 — an unverified domain resolves to public_surface scope", async () => {
    const status = await harness({}, []).status(PROJECT);
    expect(status.verified).toBe(false);
    expect(status.audit_scope).toBe("public_surface");
  });

  it("scenario 9 — a domain verified by ANY method resolves to full scope", async () => {
    const rows = [
      { id: "v1", domain: "hubspot.com", method: "dns_txt", nonce: "n1", verified_at: null, last_checked_at: null, failure_reason: "record_absent" },
      { id: "v2", domain: "hubspot.com", method: "meta_tag", nonce: "n2", verified_at: new Date(), last_checked_at: new Date(), failure_reason: null },
    ];
    const status = await harness({}, rows).status(PROJECT);

    // AC5 — "a customer can verify by any one". A failed DNS attempt alongside
    // a successful tag is verified, not half-verified.
    expect(status.verified).toBe(true);
    expect(status.audit_scope).toBe("full");
  });

  it("404s for a project that does not exist or is another tenant's", async () => {
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: { query: vi.fn(async () => ({ rows: [] })) },
    } as never);
    const service = new DomainVerificationService({ resolveTxt: vi.fn(), fetch: vi.fn() } as unknown as CheckDeps);
    const error = await service.start(PROJECT, "dns_txt").catch((e: unknown) => e);
    expect((error as DomainError).code).toBe("not_found");
  });

  it("takes no workspace_id predicate on reads — RLS scopes them (NFR-SEC-01)", async () => {
    await harness().start(PROJECT, "dns_txt");
    for (const call of calls) {
      if (call.sql.includes("INSERT INTO")) continue; // an insert names the column it fills
      expect(call.sql).not.toContain("workspace_id = ");
    }
  });
});
