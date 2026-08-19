import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH, canonicalizeAuditContent, computeRowHash, verifyChain, type AuditChainRow } from "./audit-chain.js";

// STORY-020 — security-and-tenancy.md §12: "row_hash = sha256(prev_hash ||
// canonical_json(row_without_hashes))", chained PER WORKSPACE. Pure
// function tests only here — no DB, no clock, no randomness (this file is
// the hashing/chaining math, not the DB write path).

function content(overrides: Partial<Parameters<typeof computeRowHash>[1]> = {}) {
  return {
    workspace_id: "ws-1",
    occurred_at: "2026-08-19T00:00:00.000Z",
    actor_type: "user" as const,
    actor_id: "user-1",
    actor_ip: "127.0.0.1",
    actor_ua: "vitest",
    action: "project.create",
    resource_type: "project",
    resource_id: "project-1",
    before_state: null,
    after_state: { name: "Acme" },
    request_id: "req-1",
    support_grant_id: null,
    severity: "info" as const,
    ...overrides,
  };
}

function row(overrides: { seq?: string; prev_hash?: Buffer } & Partial<ReturnType<typeof content>> = {}): AuditChainRow {
  const { seq, prev_hash, ...contentOverrides } = overrides;
  const c = content(contentOverrides);
  const prevHash = prev_hash ?? GENESIS_HASH;
  return {
    seq: seq ?? "1",
    prev_hash: prevHash,
    row_hash: computeRowHash(prevHash, c),
    ...c,
  };
}

describe("STORY-020 · canonicalizeAuditContent", () => {
  it("produces the same bytes regardless of the object literal's own key order", () => {
    const a = canonicalizeAuditContent(content());
    const { severity, request_id, ...rest } = content();
    const reordered = { severity, request_id, ...rest };
    const b = canonicalizeAuditContent(reordered);
    expect(a).toBe(b);
  });

  it("canonicalizes nested before/after state deterministically too", () => {
    const a = canonicalizeAuditContent(content({ after_state: { z: 1, a: 2 } }));
    const b = canonicalizeAuditContent(content({ after_state: { a: 2, z: 1 } }));
    expect(a).toBe(b);
  });
});

describe("STORY-020 · computeRowHash", () => {
  it("matches a hand-computed sha256(prev_hash || canonical_json(content))", () => {
    const c = content();
    const expected = createHash("sha256")
      .update(GENESIS_HASH)
      .update(Buffer.from(canonicalizeAuditContent(c), "utf8"))
      .digest();
    expect(computeRowHash(GENESIS_HASH, c)).toEqual(expected);
  });

  it("changes if any single field of the content changes", () => {
    const base = computeRowHash(GENESIS_HASH, content());
    const changed = computeRowHash(GENESIS_HASH, content({ action: "project.delete" }));
    expect(changed.equals(base)).toBe(false);
  });

  it("changes if prev_hash changes, holding content fixed", () => {
    const c = content();
    const withGenesis = computeRowHash(GENESIS_HASH, c);
    const withOther = computeRowHash(createHash("sha256").update("other").digest(), c);
    expect(withOther.equals(withGenesis)).toBe(false);
  });
});

describe("STORY-020 · verifyChain", () => {
  it("scenario 5 — an untampered chain of several rows verifies clean", () => {
    const r1 = row({ seq: "1" });
    const r2 = row({ seq: "2", prev_hash: r1.row_hash, action: "project.update" });
    const r3 = row({ seq: "3", prev_hash: r2.row_hash, action: "project.delete" });
    expect(verifyChain([r1, r2, r3])).toBeNull();
  });

  it("an empty chain verifies clean (nothing to walk)", () => {
    expect(verifyChain([])).toBeNull();
  });

  it("scenario 6 — tampering with a row's content in a copy is detected as a hash mismatch", () => {
    const r1 = row({ seq: "1" });
    const r2 = row({ seq: "2", prev_hash: r1.row_hash, action: "project.update" });
    const tamperedCopy = { ...r2, action: "project.delete" }; // content changed, row_hash NOT recomputed
    const mismatch = verifyChain([r1, tamperedCopy]);
    expect(mismatch).toEqual({ seq: "2", reason: "hash_mismatch" });
  });

  it("detects a broken prev_hash link even when each row's own hash is internally self-consistent", () => {
    const r1 = row({ seq: "1" });
    const foreignPrev = createHash("sha256").update("someone-elses-chain").digest();
    const r2content = content({ action: "project.update" });
    const r2 = {
      seq: "2",
      prev_hash: foreignPrev,
      row_hash: computeRowHash(foreignPrev, r2content),
      ...r2content,
    };
    const mismatch = verifyChain([r1, r2]);
    expect(mismatch).toEqual({ seq: "2", reason: "prev_hash_mismatch" });
  });

  it("reports the FIRST mismatch, not a later one, when more than one row is broken", () => {
    const r1 = row({ seq: "1" });
    const r2 = row({ seq: "2", prev_hash: r1.row_hash, action: "project.update" });
    const r3 = row({ seq: "3", prev_hash: r2.row_hash, action: "project.delete" });
    const tampered2 = { ...r2, action: "tampered" };
    const tampered3 = { ...r3, action: "also-tampered" };
    expect(verifyChain([r1, tampered2, tampered3])).toEqual({ seq: "2", reason: "hash_mismatch" });
  });

  it("scenario 10 — a legitimate 'audit.chain.rechained' marker exempts rows BEFORE it from strict verification", () => {
    const r1 = row({ seq: "1" });
    // Simulates requestIndividualErasure mutating r1's actor_id without
    // recomputing row_hash — r1's stored row_hash no longer matches its
    // (now pseudonymised) content, but this is a documented, legitimate
    // erasure, not tampering.
    const pseudonymisedR1 = { ...r1, actor_id: "00000000-0000-0000-0000-000000000000" };
    const markerContent = content({
      action: "audit.chain.rechained",
      actor_type: "system",
      actor_id: "00000000-0000-0000-0000-000000000000",
      resource_type: "audit_log",
      resource_id: null,
      before_state: null,
      after_state: { reason: "individual_erasure" },
      severity: "notice",
    });
    const marker = {
      seq: "2",
      prev_hash: r1.row_hash, // chained onto the ACTUAL stored tail, per AuditChainService.append
      row_hash: computeRowHash(r1.row_hash, markerContent),
      ...markerContent,
    };
    const r3 = row({ seq: "3", prev_hash: marker.row_hash, action: "project.update" });

    expect(verifyChain([pseudonymisedR1, marker, r3])).toBeNull();
  });

  it("still verifies strictly from the marker onward — a mismatch AFTER the marker still pages", () => {
    const r1 = row({ seq: "1" });
    const pseudonymisedR1 = { ...r1, actor_id: "00000000-0000-0000-0000-000000000000" };
    const markerContent = content({ action: "audit.chain.rechained", actor_type: "system", severity: "notice" });
    const marker = {
      seq: "2",
      prev_hash: r1.row_hash,
      row_hash: computeRowHash(r1.row_hash, markerContent),
      ...markerContent,
    };
    const r3 = row({ seq: "3", prev_hash: marker.row_hash, action: "project.update" });
    const tamperedR3 = { ...r3, action: "tampered-after-marker" };

    expect(verifyChain([pseudonymisedR1, marker, tamperedR3])).toEqual({ seq: "3", reason: "hash_mismatch" });
  });
});
