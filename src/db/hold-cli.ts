import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { z } from "zod";
import { connect, requireDatabaseUrl } from "./client.js";
import { LEGAL_DELAY_NOTICE_DRAFT } from "../lib/compliance/legal-delay-notice.js";
import { LegalHoldError, placeLegalHold } from "../lib/compliance/legal-hold.js";
import { releaseLegalHoldAndRunQueue } from "../lib/compliance/subject-request.js";
import { incrementCounter } from "../lib/telemetry/metrics.js";

// STORY-111 / owner decision 70 (e, f) - the operator-run legal hold commands:
//
//   pnpm db:hold:place   -- --scope <project|workspace> --id <uuid> --reason <text> --requested-by <uuid> --approved-by <uuid>
//                           --expires <ISO 8601 timestamp> --confirm <same id> [--request-id <uuid>]
//   pnpm db:hold:release -- --hold <uuid> --released-by <uuid> --confirm <same hold uuid> [--request-id <uuid>]
//
// Owner connection (DATABASE_URL), never a request handler. A hold blocks purges and individual erasure, so BOTH commands need `--confirm`
// repeating the id they act on; without it nothing is changed. Every run has a request id (supplied, else generated) printed on the first
// line and written onto the audit row (`legal_hold.placed` / `legal_hold.released`), so the command and the trail are tied by one id.
// Releasing goes through `releaseLegalHoldAndRunQueue`: the erasures the hold was delaying run as the hold ends.
//   * The hold's reason is operator-written text about a legal matter: it is stored in `legal_holds` and never printed or logged here.
//   * Placing prints the DRAFT subject notice (legal-delay-notice.ts) so the operator sends reviewed wording, not improvised wording.
//   * Exit codes: 0 done, 1 failure, 2 usage / refused before any change.
// Errors print a code or the error class and nothing else: a pg message can carry a value.

export type HoldCliArgs =
  | { command: "place"; scope: "project" | "workspace"; id: string; reason: string; requestedBy: string; approvedBy: string; expires: Date; confirm?: string; requestId?: string }
  | { command: "release"; hold: string; releasedBy: string; confirm?: string; requestId?: string };

export type ParsedHoldArgs = { ok: true; args: HoldCliArgs } | { ok: false; message: string };

const FLAGS = {
  place: ["--scope", "--id", "--reason", "--requested-by", "--approved-by", "--expires", "--confirm", "--request-id"],
  release: ["--hold", "--released-by", "--confirm", "--request-id"],
} as const;
const REQUIRED = {
  place: ["--scope", "--id", "--reason", "--requested-by", "--approved-by", "--expires"],
  release: ["--hold", "--released-by"],
} as const;
const uuid = z.uuid();
const logger = new Logger("hold-cli");

export function parseHoldArgs(argv: readonly string[]): ParsedHoldArgs {
  const [command, ...rest] = argv;
  if (command !== "place" && command !== "release") return { ok: false, message: "usage: <place|release> ..." };
  const allowed: readonly string[] = FLAGS[command];
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (!allowed.includes(flag)) return { ok: false, message: "unknown option; allowed: " + allowed.join(" ") };
    if (value === undefined || value.startsWith("--")) return { ok: false, message: `${flag} needs a value` };
    values.set(flag, value);
  }
  for (const required of REQUIRED[command]) if (!values.has(required)) return { ok: false, message: `${required} is required` };
  for (const idFlag of ["--id", "--requested-by", "--approved-by", "--hold", "--released-by", "--request-id"]) {
    const v = values.get(idFlag);
    if (v !== undefined && !uuid.safeParse(v).success) return { ok: false, message: `${idFlag} must be a UUID` };
  }
  const common = { ...(values.has("--confirm") ? { confirm: values.get("--confirm")! } : {}), ...(values.has("--request-id") ? { requestId: values.get("--request-id")! } : {}) };
  if (command === "release") return { ok: true, args: { command, hold: values.get("--hold")!, releasedBy: values.get("--released-by")!, ...common } };
  const scope = values.get("--scope")!;
  if (scope !== "project" && scope !== "workspace") return { ok: false, message: "--scope must be project or workspace" };
  const expires = new Date(values.get("--expires")!);
  if (Number.isNaN(expires.getTime())) return { ok: false, message: "--expires must be an ISO 8601 timestamp" };
  return {
    ok: true,
    args: { command, scope, id: values.get("--id")!, reason: values.get("--reason")!, requestedBy: values.get("--requested-by")!, approvedBy: values.get("--approved-by")!, expires, ...common },
  };
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/** Runs one command; returns the process exit code. */
export async function runHoldCommand(client: ClientBase, argv: readonly string[], io: CliIo, now: Date = new Date()): Promise<number> {
  const parsed = parseHoldArgs(argv);
  if (!parsed.ok) {
    io.err(parsed.message);
    return 2;
  }
  const args = parsed.args;
  const target = args.command === "place" ? args.id : args.hold;
  if (args.confirm !== target) {
    const what = args.command === "place" ? "placing a hold blocks purges and erasure" : "releasing a hold runs the erasures it delayed, which cannot be undone";
    io.err(what + "; repeat the id with --confirm <id> to proceed. Nothing was changed.");
    return 2;
  }
  const requestId = args.requestId ?? randomUUID();
  try {
    if (args.command === "place") {
      const placed = await placeLegalHold(client, { scope: args.scope, scopeId: args.id, reason: args.reason, requestedBy: args.requestedBy, approvedBy: args.approvedBy, expiresAt: args.expires, now, requestId });
      io.out(`request_id=${requestId} kind=legal_hold_place status=placed hold_id=${placed.id} scope=${args.scope} expires_at=${args.expires.toISOString()}`);
      io.out("Draft subject notice for any erasure this hold delays (replace {{request_id}} with that erasure's request id):");
      io.out(LEGAL_DELAY_NOTICE_DRAFT);
    } else {
      const run = await releaseLegalHoldAndRunQueue(client, args.hold, args.releasedBy, now, requestId);
      io.out(`request_id=${requestId} kind=legal_hold_release status=released executed=${String(run.executed)} blocked=${String(run.blocked)} still_held=${String(run.stillHeld)}`);
    }
    incrementCounter("nominara_compliance_hold_cli_commands_total", { command: args.command, outcome: "ok" });
    logger.log({ event: "hold_cli", request_id: requestId, command: args.command, outcome: "ok" });
    return 0;
  } catch (error) {
    // A refusal the operator can act on (same person, short reason, expiry, unknown id, not active) is exit 2: nothing was changed.
    if (error instanceof LegalHoldError) {
      incrementCounter("nominara_compliance_hold_cli_commands_total", { command: args.command, outcome: error.code });
      io.err(`refused (${error.code}): ${error.message}. Nothing was changed. request_id=${requestId}`);
      return 2;
    }
    incrementCounter("nominara_compliance_hold_cli_commands_total", { command: args.command, outcome: "failed" });
    logger.error({ event: "hold_cli", request_id: requestId, command: args.command, outcome: "failed", error: error instanceof Error ? error.name : "unknown" });
    io.err(`request failed (${error instanceof Error ? error.name : "unknown"}); see the audit trail for request id ${requestId}.`);
    return 1;
  }
}

async function main(): Promise<void> {
  const client = await connect(requireDatabaseUrl());
  try {
    process.exitCode = await runHoldCommand(client, process.argv.slice(2).filter((a) => a !== "--"), { out: (l) => console.log(l), err: (l) => console.error(l) });
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
