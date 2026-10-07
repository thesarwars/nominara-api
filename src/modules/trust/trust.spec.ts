import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SUPPORT_GRANT_MAX_TTL_MINUTES,
  accessGrantListResponseSchema,
  supportGrantCreateInputSchema,
} from "../../../contracts/trust/access-grant.schema.js";
import { parseSupportGrantArgs, parseSupportRevokeArgs } from "../../workers/support/support-grant.js";

const W = "0190a000-0000-7000-8000-000000000001";
const U1 = "0190a000-0000-7000-8000-000000000002";
const U2 = "0190a000-0000-7000-8000-000000000003";
const flags = (over: Record<string, string | undefined> = {}): string[] => {
  const base: Record<string, string | undefined> = {
    workspace: W,
    "requested-by": U1,
    "approved-by": U2,
    scope: "metadata",
    "ttl-minutes": "60",
    ticket: "SUP-1",
    justification: "customer asked us to look at a failed capture",
    operator: "alice",
    ...over,
  };
  return Object.entries(base).flatMap(([k, v]) => (v === undefined ? [] : [`--${k}`, v]));
};

describe("NEW-D-5 · the ops CLI refuses an unsafe grant before touching the database", () => {
  it("NEW-D-5 AC2 · a valid grant parses; write access is off unless --allow-write is passed", () => {
    expect(parseSupportGrantArgs(flags())).toMatchObject({ workspace_id: W, ttl_minutes: 60, allow_write: false, scope: "metadata" });
    expect(parseSupportGrantArgs([...flags(), "--allow-write"]).allow_write).toBe(true);
  });

  it("NEW-D-5 AC2 · TTL is at most 4 hours: 240 minutes passes, 241 is refused, 0 and non-numbers are refused", () => {
    expect(SUPPORT_GRANT_MAX_TTL_MINUTES).toBe(240);
    expect(parseSupportGrantArgs(flags({ "ttl-minutes": "240" })).ttl_minutes).toBe(240);
    for (const bad of ["241", "0", "-5", "1.5", "abc", "1e3"]) {
      expect(() => parseSupportGrantArgs(flags({ "ttl-minutes": bad })), bad).toThrow();
    }
  });

  it("NEW-D-5 AC2 · self-approval is refused at parsing (the database CHECK is the second line, not the first)", () => {
    expect(() => parseSupportGrantArgs(flags({ "approved-by": U1 }))).toThrow(/different|self|dual/i);
  });

  it("NEW-D-5 AC2 · every flag is mandatory, including the prose ones", () => {
    for (const name of ["workspace", "requested-by", "approved-by", "scope", "ttl-minutes", "ticket", "justification", "operator"]) {
      expect(() => parseSupportGrantArgs(flags({ [name]: undefined })), name).toThrow();
    }
  });

  it("NEW-D-5 AC2 · an unknown scope is refused", () => {
    expect(() => parseSupportGrantArgs(flags({ scope: "root" }))).toThrow();
  });

  it("NEW-D-5 AC2 · revoke needs the workspace, the grant and an operator", () => {
    const ok = ["--workspace", W, "--grant", U1, "--operator", "alice"];
    expect(parseSupportRevokeArgs(ok)).toMatchObject({ workspaceId: W, grantId: U1, operator: "alice" });
    expect(() => parseSupportRevokeArgs(["--workspace", W, "--operator", "alice"])).toThrow();
    expect(() => parseSupportRevokeArgs(["--workspace", "nope", "--grant", U1, "--operator", "a"])).toThrow();
  });

  it("NEW-D-5 AC2 · the create-input schema is .strict()", () => {
    const input = { workspace_id: W, requested_by: U1, approved_by: U2, scope: "full", justification: "j", ticket_ref: "t", ttl_minutes: 5, operator: "o" };
    expect(supportGrantCreateInputSchema.safeParse(input).success).toBe(true);
    expect(supportGrantCreateInputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false);
  });
});

describe("NEW-D-5 · the read contract publishes no staff identity", () => {
  it("NEW-D-5 AC1 · a listed grant carries scope, allow_write, expires_at, ticket_ref and justification, and refuses requested_by/approved_by", () => {
    const g = { id: W, scope: "findings", allow_write: false, ticket_ref: "T", justification: "j", expires_at: "2026-10-07T12:00:00.000Z", created_at: "2026-10-07T11:00:00.000Z" };
    expect(accessGrantListResponseSchema.safeParse([g]).success).toBe(true);
    expect(accessGrantListResponseSchema.safeParse([{ ...g, requested_by: U1 }]).success).toBe(false);
  });
});

describe("NEW-D-5 · no HTTP route can create or revoke a grant", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".spec.ts") ? [p] : [];
    });

  it("NEW-D-5 AC2 · the trust controller declares GET handlers only", () => {
    const src = readFileSync(path.join(root, "modules/trust/trust.controller.ts"), "utf8");
    expect(src).toMatch(/@Get\(/u);
    expect(src).not.toMatch(/@(Post|Put|Patch|Delete|All)\(/u);
  });

  it("NEW-D-5 AC2 · the write functions are imported by the CLI alone and are not a Nest provider", () => {
    const lib = path.join(root, "lib/support/support-grants.ts");
    expect(readFileSync(lib, "utf8")).not.toMatch(/@(Injectable|Controller|Module)\b/u);
    const importers = walk(root).filter((f) => f !== lib && /support-grants\.js["']/u.test(readFileSync(f, "utf8")) && /lib\/support\/support-grants\.js|\.\/support-grants\.js/u.test(readFileSync(f, "utf8")));
    expect(importers.map((f) => path.relative(root, f))).toEqual(["workers/support/support-grant.ts"]);
  });
});
