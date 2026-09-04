import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireDatabaseUrl } from "./client.js";

// STORY-128 — `pnpm db:studio`, a preflight in front of `drizzle-kit studio`.
//
// Studio is a read/WRITE table browser over whatever DATABASE_URL points at.
// Two properties make it worth a guard rather than a note in a README:
//
//   1. DATABASE_URL is the OWNER connection (src/db/migrate.ts's, not
//      DATABASE_URL_POOLED's nominara_app). The owner is not subject to the
//      RLS policies migration 0006 generates, so Studio shows and edits
//      every tenant's rows at once. That is the right connection for a
//      schema browser and the wrong one to point anywhere real.
//   2. It edits. A mis-click is an UPDATE, and there is no confirmation
//      step between a cell and a committed write.
//
// So the target has to be a local host. This is the same posture
// src/db/dev-credentials.ts takes — a tool with no production path that says
// so — except that script only sets known-local passwords, while this one
// would happily open production if DATABASE_URL happened to name it.

/** Hostnames that are a developer's own machine, and nothing else. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal", "postgres"]);

export class NonLocalStudioTargetError extends Error {
  constructor(host: string) {
    super(
      `refusing to open Drizzle Studio against "${host}". Studio connects as the database OWNER, which RLS does ` +
        "not constrain, and it writes — so it would expose and edit every tenant's rows at once. It is a local " +
        `development tool; DATABASE_URL must name one of: ${[...LOCAL_HOSTS].join(", ")}.`,
    );
    this.name = "NonLocalStudioTargetError";
  }
}

/** Throws unless `databaseUrl` names a local host. Exported for its test. */
export function assertLocalTarget(databaseUrl: string): void {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    // An unparseable URL is not evidence of a local target. Refuse rather
    // than pass it through to Studio and find out.
    throw new NonLocalStudioTargetError("(unparseable DATABASE_URL)");
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new NonLocalStudioTargetError(host);
  }
}

async function main(): Promise<void> {
  assertLocalTarget(requireDatabaseUrl());

  // --host 127.0.0.1, never drizzle-kit's 0.0.0.0 default: 0.0.0.0 binds
  // every interface, so an unauthenticated read/write view of the whole
  // database would be reachable from anything else on the network.
  const child = spawn("drizzle-kit", ["studio", "--host", "127.0.0.1", ...process.argv.slice(2)], {
    stdio: "inherit",
    shell: false,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
