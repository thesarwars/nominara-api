import { open, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";
import { z } from "zod";
import { connect, requireDatabaseUrl } from "./client.js";
import { processAccessRequest, processErasureRequest } from "../lib/compliance/subject-request.js";

// STORY-111 / owner decision 68 (a) - the operator-run subject request commands:
//
//   pnpm db:subject:export -- --user <uuid> --requested-by <operator uuid> --out <file> [--request-id <uuid>]
//   pnpm db:subject:erase  -- --user <uuid> --requested-by <operator uuid> --confirm <same user uuid> [--request-id <uuid>]
//
// Support runs these on the OWNER connection (DATABASE_URL), never a request handler (subject-request.ts header). Safety:
//   * Identification is by id only; no email is accepted, printed, or logged. The export document goes to a FILE created exclusively with mode
//     0600 (an existing file is never overwritten); stdout carries a summary of counts and the request id.
//   * Erasure is irreversible, so it needs `--confirm` repeating the subject id. Without it nothing is changed.
//   * `--requested-by` must be an existing user: the audit rows in every workspace of the subject record that operator as the actor.
//   * A legal hold defers erasure (decision 68b): the command exits 0 and prints the delay reason; the queue runs on hold release / nightly.
//   * Exit codes: 0 done or deferred, 1 failure, 2 usage / refused before any change, 3 erasure blocked (sole owner).
// Errors print the error class and nothing else: a pg message can carry a value.

export type SubjectCliArgs =
  | { command: "export"; user: string; requestedBy: string; out: string; requestId?: string }
  | { command: "erase"; user: string; requestedBy: string; confirm?: string; requestId?: string };

export type ParsedSubjectArgs = { ok: true; args: SubjectCliArgs } | { ok: false; message: string };

const FLAGS = { export: ["--user", "--requested-by", "--out", "--request-id"], erase: ["--user", "--requested-by", "--confirm", "--request-id"] } as const;
const uuid = z.uuid();

export function parseSubjectArgs(argv: readonly string[]): ParsedSubjectArgs {
  const [command, ...rest] = argv;
  if (command !== "export" && command !== "erase") return { ok: false, message: "usage: <export|erase> --user <id> --requested-by <id> ..." };
  const allowed: readonly string[] = FLAGS[command];
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (!allowed.includes(flag)) return { ok: false, message: "unknown option; allowed: " + allowed.join(" ") };
    if (value === undefined || value.startsWith("--")) return { ok: false, message: `${flag} needs a value` };
    values.set(flag, value);
  }
  for (const required of command === "export" ? ["--user", "--requested-by", "--out"] : ["--user", "--requested-by"]) {
    if (!values.has(required)) return { ok: false, message: `${required} is required` };
  }
  for (const idFlag of ["--user", "--requested-by", "--request-id"]) {
    const v = values.get(idFlag);
    if (v !== undefined && !uuid.safeParse(v).success) return { ok: false, message: `${idFlag} must be a UUID` };
  }
  const base = { user: values.get("--user")!, requestedBy: values.get("--requested-by")!, ...(values.has("--request-id") ? { requestId: values.get("--request-id")! } : {}) };
  return command === "export"
    ? { ok: true, args: { command, ...base, out: values.get("--out")! } }
    : { ok: true, args: { command, ...base, ...(values.has("--confirm") ? { confirm: values.get("--confirm")! } : {}) } };
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

async function userExists(client: ClientBase, id: string): Promise<boolean> {
  return ((await client.query("SELECT 1 FROM users WHERE id = $1", [id])).rowCount ?? 0) > 0;
}

/** Runs one command; returns the process exit code. */
export async function runSubjectCommand(client: ClientBase, argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseSubjectArgs(argv);
  if (!parsed.ok) {
    io.err(parsed.message);
    return 2;
  }
  const args = parsed.args;
  if (args.command === "erase" && args.confirm !== args.user) {
    io.err("erasure is irreversible: repeat the subject id with --confirm <user id> to proceed. Nothing was changed.");
    return 2;
  }
  if (!(await userExists(client, args.requestedBy))) {
    io.err("--requested-by is not a known user; nothing was changed.");
    return 2;
  }
  if (!(await userExists(client, args.user))) {
    io.err("--user is not a known user; nothing was changed.");
    return 2;
  }
  const ctx = { requestedBy: args.requestedBy, ...(args.requestId !== undefined ? { requestId: args.requestId } : {}) };
  try {
    if (args.command === "export") {
      // Exclusive create: an existing file (possibly someone else's export) is never overwritten.
      let handle;
      try {
        handle = await open(args.out, "wx", 0o600);
      } catch {
        io.err("cannot create the output file (it exists, or the path is not writable); nothing was exported.");
        return 1;
      }
      let written = false;
      try {
        const document = await processAccessRequest(client, args.user, ctx);
        await handle.writeFile(JSON.stringify(document, null, 2));
        written = true;
        io.out(`request_id=${document.request_id} kind=access status=completed tables=${String(document.tables.length)} rows=${String(document.tables.reduce((n, t) => n + t.row_count, 0))} file=${args.out}`);
      } finally {
        await handle.close();
        // This command created the file a moment ago (exclusive create), so removing it is safe; a failed export must not leave an empty file
        // that makes the retry look like a path problem.
        if (!written) await unlink(args.out).catch(() => undefined);
      }
      return 0;
    }
    const outcome = await processErasureRequest(client, args.user, ctx);
    io.out(`request_id=${outcome.requestId} kind=erasure status=${outcome.status}${outcome.reason !== null ? ` reason="${outcome.reason}"` : ""}`);
    return outcome.status === "blocked" ? 3 : 0;
  } catch (error) {
    io.err(`request failed (${error instanceof Error ? error.name : "unknown"}); see the audit trail for the request id.`);
    return 1;
  }
}

async function main(): Promise<void> {
  const client = await connect(requireDatabaseUrl());
  try {
    process.exitCode = await runSubjectCommand(client, process.argv.slice(2).filter((a) => a !== "--"), { out: (l) => console.log(l), err: (l) => console.error(l) });
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
