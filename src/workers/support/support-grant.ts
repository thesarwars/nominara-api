import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SUPPORT_GRANT_MAX_TTL_MINUTES, SUPPORT_GRANT_SCOPES, supportGrantCreateInputSchema, type SupportGrantCreateInput } from "../../../contracts/trust/access-grant.schema.js";
import { loadEnv } from "../../config/env.js";
import { createPgPool } from "../../db/pg-pool.js";
import { grantSupportAccess, revokeSupportAccess } from "../../lib/support/support-grants.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";

// NEW-D-5 — the ONLY way a support grant is created or revoked (security-and-tenancy.md §11).
// An operator's script, not a route; no HTTP schema accepts a grant. Shaped on
// src/workers/billing/plan-set.ts, and under the same rule: never a Nest provider.
//
// Usage:
//   pnpm support:grant  --workspace <uuid> --requested-by <uuid> --approved-by <uuid> \
//                       --scope metadata|findings|full --ttl-minutes <1..240> \
//                       --ticket <ref> --justification <text> --operator <who> [--allow-write]
//   pnpm support:revoke --workspace <uuid> --grant <uuid> --operator <who>

export class SupportGrantUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportGrantUsageError";
  }
}

function flagMap(argv: readonly string[], booleans: readonly string[]): { flags: Map<string, string>; set: Set<string> } {
  const flags = new Map<string, string>();
  const set = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    if (booleans.includes(name)) {
      set.add(name);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new SupportGrantUsageError(`${token} needs a value`);
    flags.set(name, value);
    i += 1;
  }
  return { flags, set };
}

function requireFlags(flags: Map<string, string>, names: readonly string[]): void {
  const missing = names.filter((n) => (flags.get(n) ?? "").trim() === "");
  if (missing.length > 0) throw new SupportGrantUsageError(`missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}`);
}

/** Exported so every refusal is testable without a database. EVERY flag is mandatory — a grant nobody can attribute is the thing §11 forbids. */
export function parseSupportGrantArgs(argv: readonly string[]): SupportGrantCreateInput {
  const { flags, set } = flagMap(argv, ["allow-write"]);
  requireFlags(flags, ["workspace", "requested-by", "approved-by", "scope", "ttl-minutes", "ticket", "justification", "operator"]);
  const ttlText = flags.get("ttl-minutes")!;
  if (!/^[0-9]+$/u.test(ttlText)) throw new SupportGrantUsageError(`--ttl-minutes must be a whole number, got ${ttlText}`);
  const ttl = Number(ttlText);
  if (ttl < 1 || ttl > SUPPORT_GRANT_MAX_TTL_MINUTES) {
    throw new SupportGrantUsageError(`--ttl-minutes must be 1..${String(SUPPORT_GRANT_MAX_TTL_MINUTES)} (4 hours maximum), got ${String(ttl)}`);
  }
  if (!(SUPPORT_GRANT_SCOPES as readonly string[]).includes(flags.get("scope")!)) {
    throw new SupportGrantUsageError(`--scope must be one of ${SUPPORT_GRANT_SCOPES.join(", ")}`);
  }
  if (flags.get("requested-by") === flags.get("approved-by")) {
    throw new SupportGrantUsageError("--approved-by must be a different person from --requested-by (dual control)");
  }
  const parsed = supportGrantCreateInputSchema.safeParse({
    workspace_id: flags.get("workspace"),
    requested_by: flags.get("requested-by"),
    approved_by: flags.get("approved-by"),
    scope: flags.get("scope"),
    allow_write: set.has("allow-write"),
    justification: flags.get("justification"),
    ticket_ref: flags.get("ticket"),
    ttl_minutes: ttl,
    operator: flags.get("operator"),
  });
  if (!parsed.success) throw new SupportGrantUsageError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

const revokeArgsSchema = z.object({ workspaceId: z.uuid(), grantId: z.uuid(), operator: z.string().trim().min(1) }).strict();
export type SupportRevokeArgs = z.infer<typeof revokeArgsSchema>;

export function parseSupportRevokeArgs(argv: readonly string[]): SupportRevokeArgs {
  const { flags } = flagMap(argv, []);
  requireFlags(flags, ["workspace", "grant", "operator"]);
  const parsed = revokeArgsSchema.safeParse({ workspaceId: flags.get("workspace"), grantId: flags.get("grant"), operator: flags.get("operator") });
  if (!parsed.success) throw new SupportGrantUsageError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}

async function withClient<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const pool = createPgPool(loadEnv().DATABASE_URL_POOLED);
  try {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function runSupportGrant(args: SupportGrantCreateInput, log: (line: string) => void = console.log): Promise<void> {
  const g = await withClient((client) =>
    withTenantContext(client, { workspaceId: args.workspace_id, actorId: SYSTEM_ACTOR_ID }, (tx) => grantSupportAccess(tx, args)),
  );
  log(`granted ${g.id} on ${args.workspace_id}: scope ${args.scope}, write ${String(args.allow_write)}, expires ${g.expires_at}`);
}

export async function runSupportRevoke(args: SupportRevokeArgs, log: (line: string) => void = console.log): Promise<void> {
  const r = await withClient((client) =>
    withTenantContext(client, { workspaceId: args.workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => revokeSupportAccess(tx, args)),
  );
  log(r.revoked ? `revoked ${args.grantId}` : `no change: ${args.grantId} is unknown in ${args.workspaceId} or already revoked`);
}

async function main(): Promise<void> {
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (command === "grant") await runSupportGrant(parseSupportGrantArgs(rest));
    else if (command === "revoke") await runSupportRevoke(parseSupportRevokeArgs(rest));
    else throw new SupportGrantUsageError("first argument must be `grant` or `revoke`");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
