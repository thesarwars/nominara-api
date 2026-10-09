import { afterEach, describe, expect, it, vi } from "vitest";
import * as tenantContext from "../../tenancy/tenant-context.js";
import type { AuditChainService } from "../audit/audit-chain.service.js";
import { ShareTokensService, activeLinkLimit, generateShareSecret, hashShareSecret } from "./share-tokens.service.js";

describe("STORY-098 · share-token secret helpers", () => {
  it("STORY-098 scenario 1 · a secret is 32 CSPRNG bytes as 43 base64url characters, never repeated", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const s = generateShareSecret();
      expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
      seen.add(s);
    }
    expect(seen.size).toBe(200);
  });

  it("STORY-098 scenario 1 · the stored hash is the 32-byte SHA-256 of the secret, and differs per secret", () => {
    const a = hashShareSecret("a".repeat(43));
    expect(a).toHaveLength(32);
    expect(a.equals(hashShareSecret("a".repeat(43)))).toBe(true);
    expect(a.equals(hashShareSecret("b".repeat(43)))).toBe(false);
  });

  it("STORY-098 · share_links.enabled resolves to an active-link ceiling; unrecognised values fail closed at 0", () => {
    expect(activeLinkLimit("10_active")).toBe(10);
    expect(activeLinkLimit("50_active")).toBe(50);
    expect(activeLinkLimit("unlimited")).toBeNull();
    expect(activeLinkLimit(true)).toBeNull();
    expect(activeLinkLimit(false)).toBe(0);
    expect(activeLinkLimit(null)).toBe(0);
    expect(activeLinkLimit(0)).toBe(0);
    expect(activeLinkLimit("surprise")).toBe(0);
    expect(activeLinkLimit(7)).toBe(7);
  });
});

// CP1 minor (carried through checkpoint 2) — an EMPTY scope must never read as "unrestricted".
// The tenant context drops an empty scope to "undefined" before a service sees it, so the guard is the
// first line; the service is the second and refuses a scope that is present but empty.
describe("CP1 e-reports · ShareTokensService treats an empty scope as scoped to nothing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function serviceWithScope(scope: string[] | undefined) {
    const query = vi.fn(async () => ({ rows: [] }));
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: { query },
      context: { workspaceId: "ws", actorId: "actor", scopeProjectIds: scope },
    } as never);
    return { service: new ShareTokensService({} as AuditChainService), query };
  }

  it("CP1 zero-scope · list() with a present-but-empty scope is refused (project_out_of_scope) and reads nothing", async () => {
    const { service, query } = serviceWithScope([]);
    await expect(service.list({ limit: 50 })).rejects.toMatchObject({ code: "project_out_of_scope" });
    expect(query).not.toHaveBeenCalled();
  });

  it("CP1 zero-scope · mint(), revoke() and views() with an empty scope are refused before any statement", async () => {
    const { service, query } = serviceWithScope([]);
    await expect(service.mint({} as never, {} as never)).rejects.toMatchObject({ code: "project_out_of_scope" });
    await expect(service.revoke("t")).rejects.toMatchObject({ code: "project_out_of_scope" });
    await expect(service.views("t", { limit: 50 })).rejects.toMatchObject({ code: "project_out_of_scope" });
    expect(query).not.toHaveBeenCalled();
  });

  it("CP1 zero-scope · an UNRESTRICTED member (scope undefined) still lists, and a narrowed one filters by scope", async () => {
    const free = serviceWithScope(undefined);
    await expect(free.service.list({ limit: 50 })).resolves.toMatchObject({ items: [] });
    expect(String((free.query.mock.calls[0] as unknown[])[0])).not.toContain("<@");
    const scoped = serviceWithScope(["00000000-0000-7000-8000-000000000001"]);
    await expect(scoped.service.list({ limit: 50 })).resolves.toMatchObject({ items: [] });
    expect(String((scoped.query.mock.calls[0] as unknown[])[0])).toContain("<@");
  });
});
