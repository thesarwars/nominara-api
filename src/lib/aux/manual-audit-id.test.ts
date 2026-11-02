import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isReservedLedgerKey } from "../credits/debit.js";
import { manualAuditIdentity } from "./manual-audit-id.js";
import { onboardingAuditId } from "./onboarding-audit.js";

// AUXLIVE-3 (review round 1, critical) - a manual audit's ledger key and audit id are DERIVED from the client's Idempotency-Key, so a replay is refused by
// the database (ux_credit_ledger_idem, the aux_audits primary key) whatever the Valkey cache holds. A random id per execution defeats that.

const WS_A = "0190b1c0-0000-7000-8000-00000000000a";
const WS_B = "0190b1c0-0000-7000-8000-00000000000b";

describe("AUXLIVE-3 · manualAuditIdentity", () => {
  it("is deterministic: the same workspace and key give the same audit id and ledger key", () => {
    expect(manualAuditIdentity(WS_A, "key-1")).toEqual(manualAuditIdentity(WS_A, "key-1"));
  });

  it("differs by key and by workspace (one tenant's key can never collide with another's)", () => {
    const base = manualAuditIdentity(WS_A, "key-1");
    expect(manualAuditIdentity(WS_A, "key-2").auditId).not.toBe(base.auditId);
    expect(manualAuditIdentity(WS_A, "key-2").ledgerKey).not.toBe(base.ledgerKey);
    expect(manualAuditIdentity(WS_B, "key-1").auditId).not.toBe(base.auditId);
    expect(manualAuditIdentity(WS_B, "key-1").ledgerKey).not.toBe(base.ledgerKey);
  });

  it("the audit id is a version-5-shaped UUID (the crawl.audit job contract requires a UUID)", () => {
    expect(manualAuditIdentity(WS_A, "key-1").auditId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("the ledger key is in the server-reserved namespace, and carries neither the workspace nor the client key in clear", () => {
    const { ledgerKey } = manualAuditIdentity(WS_A, "secret-client-key");
    expect(isReservedLedgerKey(ledgerKey)).toBe(true);
    expect(ledgerKey).not.toContain("secret-client-key");
    expect(ledgerKey).not.toContain(WS_A);
  });

  it("is not the onboarding audit's id for the same input (separate namespaces)", () => {
    expect(manualAuditIdentity(WS_A, "p").auditId).not.toBe(onboardingAuditId("p"));
  });

  // OWNER DECISION 48 - the 24-hour replay window. Past it, the same client key must mean a NEW audit and a NEW ledger key, so the identity carries a
  // generation. Generation 0 is the identity as it has always been (every audit already made keeps its id and its ledger key).
  it("D48 · generation 0 is the original identity, byte for byte (audits already made keep their ids)", () => {
    const digest = createHash("sha256").update(["nominara.aux.manual-audit.v1", WS_A, "key-1"].join("|")).digest();
    const id = manualAuditIdentity(WS_A, "key-1", 0);
    expect(id).toEqual(manualAuditIdentity(WS_A, "key-1"));
    expect(id.ledgerKey).toBe(["aux_audit", digest.toString("hex")].join(":"));
  });

  it("D48 · each later generation is a different audit id and a different ledger key, still deterministic and still in the reserved namespace", () => {
    const seen = new Set<string>();
    const ledger = new Set<string>();
    for (let g = 0; g < 5; g += 1) {
      const id = manualAuditIdentity(WS_A, "key-1", g);
      expect(manualAuditIdentity(WS_A, "key-1", g)).toEqual(id);
      expect(id.auditId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(isReservedLedgerKey(id.ledgerKey)).toBe(true);
      seen.add(id.auditId);
      ledger.add(id.ledgerKey);
    }
    expect(seen.size).toBe(5);
    expect(ledger.size).toBe(5);
  });

  it("D48 · a generation is never confused with a key: (key-1, generation 1) is not the identity of the key 'key-1|1'", () => {
    expect(manualAuditIdentity(WS_A, "key-1", 1).auditId).not.toBe(manualAuditIdentity(WS_A, "key-1|1", 0).auditId);
  });
});
