import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptGraceSuccessor, generateRefreshToken, hashRefreshToken, serializeGraceSlot } from "../../src/lib/auth/refresh-token.js";
import { SessionService } from "../../src/modules/identity/session.service.js";

vi.mock("../../src/config/env.js", () => ({ loadEnv: () => ({ REFRESH_TOKEN_GRACE_WINDOW_MS: 2_000 }) }));

// Batch 19 (decision 108(a)) - session.reuse_detected and session.refresh_grace_reuse are written to the audit chain, not only logged and counted.
// A scripted pool: the statements are matched by their text, and every statement is recorded so the audit write can be asserted on - what it
// wrote, in which workspace, inside a tenant-context transaction, and that it did not happen at all when there is no workspace to put it in.

const SID = "00000000-0000-7000-8000-0000000000a1";
const USER = "00000000-0000-7000-8000-0000000000b1";
const WS = "00000000-0000-7000-8000-0000000000c1";

interface Script {
  readonly activeWorkspaceId: string | null;
  readonly verified: boolean;
  readonly revokeRowCount?: number;
  readonly auditFails?: boolean;
}

function harness(script: Script, cacheValue?: string) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    release: () => undefined,
    query: async (text: string, values: unknown[] = []) => {
      statements.push({ text, values });
      if (/FROM refresh_tokens WHERE token_hash = \$1 FOR UPDATE/.test(text)) {
        return { rows: [{ id: "t1", session_id: SID, consumed_at: new Date(), expires_at: new Date(Date.now() + 1e9) }] };
      }
      if (/FROM sessions WHERE id = \$1 FOR UPDATE/.test(text)) {
        return { rows: [{ id: SID, user_id: USER, revoked_at: null, active_workspace_id: script.activeWorkspaceId }] };
      }
      if (/SELECT 1 FROM refresh_tokens/.test(text)) return { rows: [{ "?column?": 1 }] };
      if (/SET revoked_at = now\(\), revoked_reason = 'reuse_detected'/.test(text)) return { rows: [], rowCount: script.revokeRowCount ?? 1 };
      if (/INSERT INTO audit_log/.test(text) && script.auditFails === true) throw new Error("audit insert failed");
      if (/pg_advisory_xact_lock/.test(text)) {
        return { rows: [{ workspace_id: values[0], actor_id: values[1], resource_id: values[2], support_grant_id: null, actor_ip: null }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const pool = {
    connect: async () => client,
    query: async (text: string) => {
      statements.push({ text, values: [] });
      if (/FROM refresh_tokens rt/.test(text)) return { rows: [{ user_id: USER, active_workspace_id: script.activeWorkspaceId }] };
      return { rows: [], rowCount: 0 };
    },
  };
  const membership = {
    getWorkspaceStatus: async () => ({ status: "active", deletedAt: null, entitlementVersion: 1 }),
    getLiveMembership: async () => (script.verified ? { status: "active", role: "owner", projectScope: null } : null),
  };
  const cache = { get: async () => cacheValue, set: async () => undefined, delete: async () => undefined };
  const service = new SessionService(pool as never, membership as never, cache as never);
  (service as unknown as { mintAccessAndCsrf: () => Promise<{ accessToken: string; csrfToken: string }> }).mintAccessAndCsrf = () =>
    Promise.resolve({ accessToken: "a", csrfToken: "c" });
  const audited = () => statements.filter((s) => /INSERT INTO audit_log/.test(s.text));
  return { service, statements, audited };
}

afterEach(() => vi.restoreAllMocks());

const insertedAction = (s: { values: unknown[] }): unknown => s.values[6];

describe("batch 19 / decision 108(a) - session security events are audited", () => {
  it("session.reuse_detected is written to the audit chain of the session's workspace, on a tenant-context transaction, naming the session and never the token", async () => {
    const h = harness({ activeWorkspaceId: WS, verified: true });
    const raw = generateRefreshToken();
    await expect(h.service.refresh(raw)).rejects.toThrow("refresh token already used");

    expect(h.audited()).toHaveLength(1);
    const row = h.audited()[0]!;
    expect(insertedAction(row)).toBe("session.reuse_detected");
    expect(row.values[0]).toBe(WS);
    expect(row.values[7]).toBe("session");
    expect(row.values[8]).toBe(SID);
    expect(JSON.stringify(row.values)).not.toContain(raw);
    // Inside withTenantContext: the workspace GUC was set (local) before the append.
    const setConfig = h.statements.findIndex((s) => /set_config/.test(s.text) && s.values[1] === WS);
    expect(setConfig).toBeGreaterThan(-1);
    expect(setConfig).toBeLessThan(h.statements.findIndex((s) => /INSERT INTO audit_log/.test(s.text)));
  });

  it("session.reuse_detected is written once per revocation: a replay of a family that is already revoked adds no second row", async () => {
    const h = harness({ activeWorkspaceId: WS, verified: true, revokeRowCount: 0 });
    await expect(h.service.refresh(generateRefreshToken())).rejects.toThrow("refresh token already used");
    expect(h.audited()).toHaveLength(0);
  });

  it("a session with no active workspace has no chain to write to: nothing is invented, the refusal is unchanged", async () => {
    const h = harness({ activeWorkspaceId: null, verified: false });
    await expect(h.service.refresh(generateRefreshToken())).rejects.toThrow("refresh token already used");
    expect(h.audited()).toHaveLength(0);
  });

  it("a session whose workspace no longer verifies (membership gone) writes nothing into that workspace's chain", async () => {
    const h = harness({ activeWorkspaceId: WS, verified: false });
    await expect(h.service.refresh(generateRefreshToken())).rejects.toThrow("refresh token already used");
    expect(h.audited()).toHaveLength(0);
  });

  it("a failing audit write does not change the outcome of the refusal, and is reported loudly rather than swallowed", async () => {
    const h = harness({ activeWorkspaceId: WS, verified: true, auditFails: true });
    const error = vi.spyOn((await import("@nestjs/common")).Logger.prototype, "error").mockImplementation(() => undefined);
    await expect(h.service.refresh(generateRefreshToken())).rejects.toThrow("refresh token already used");
    expect(error).toHaveBeenCalled();
    expect(h.statements.some((s) => s.text === "ROLLBACK")).toBe(true);
  });

  it("session.refresh_grace_reuse is written for a grace-window hit, in the session's workspace", async () => {
    const predecessor = generateRefreshToken();
    const successor = generateRefreshToken();
    const slot = serializeGraceSlot({ predecessorHash: hashRefreshToken(predecessor), successorCiphertext: encryptGraceSuccessor(SID, predecessor, successor) });
    const h = harness({ activeWorkspaceId: WS, verified: true }, slot);
    const tokens = await h.service.refresh(predecessor);

    expect(tokens.refreshToken).toBe(successor);
    expect(h.audited()).toHaveLength(1);
    const row = h.audited()[0]!;
    expect(insertedAction(row)).toBe("session.refresh_grace_reuse");
    expect(row.values[0]).toBe(WS);
    expect(JSON.stringify(row.values)).not.toContain(predecessor);
    expect(JSON.stringify(row.values)).not.toContain(successor);
  });

  it("a grace hit whose audit write fails still returns the successor (a legitimate refresh is not failed by its own audit), and the failure is loud", async () => {
    const predecessor = generateRefreshToken();
    const successor = generateRefreshToken();
    const slot = serializeGraceSlot({ predecessorHash: hashRefreshToken(predecessor), successorCiphertext: encryptGraceSuccessor(SID, predecessor, successor) });
    const h = harness({ activeWorkspaceId: WS, verified: true, auditFails: true }, slot);
    const error = vi.spyOn((await import("@nestjs/common")).Logger.prototype, "error").mockImplementation(() => undefined);
    expect((await h.service.refresh(predecessor)).refreshToken).toBe(successor);
    expect(error).toHaveBeenCalled();
  });
});
