import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";
import { connect, requireDatabaseUrl } from "../../db/client.js";
import { hashEmailKey, normalizeEmail } from "../auth/email-otp.js";

// STORY-178 / owner decision 9 — `pnpm email:unsuppress <address>`: the OPERATOR's way to lift a suppression (the address was
// fixed, the mailbox is back). It is the only way for D1: no customer UI, and no runtime role may UPDATE or DELETE the table
// (migration 0141 grants the API INSERT/SELECT and a worker SELECT), so this runs on the OWNER connection (DATABASE_URL).
//
// It lifts every ACTIVE suppression of the address (a bounce and a complaint alike) by marking `deleted_at`; the rows stay, so
// a redelivery of the event that created one is still a conflict and cannot bring the suppression back. Only a NEW event can.
// A lift is deliberate and rare, so it leaves one log line: the peppered HASH, the count, never the address.

export async function liftSuppression(client: ClientBase, address: string, pepper: string): Promise<number> {
  const normalized = normalizeEmail(address);
  if (normalized === "") throw new Error("an address is required");
  if (pepper === "") throw new Error("OTP_EMAIL_HASH_PEPPER is required: the table holds the peppered hash, so the address cannot be matched without it");
  const lifted = await client.query("UPDATE email_suppressions SET deleted_at = now() WHERE recipient_hash = $1 AND deleted_at IS NULL", [hashEmailKey(normalized, pepper)]);
  return lifted.rowCount ?? 0;
}

async function main(): Promise<void> {
  const address = process.argv[2];
  if (address === undefined || address.startsWith("-")) {
    console.error("usage: pnpm email:unsuppress <address>   (DATABASE_URL = the owner connection, OTP_EMAIL_HASH_PEPPER = the API's pepper)");
    process.exitCode = 2;
    return;
  }
  const pepper = process.env.OTP_EMAIL_HASH_PEPPER ?? "";
  const client = await connect(requireDatabaseUrl());
  try {
    const lifted = await liftSuppression(client, address, pepper);
    const hash = hashEmailKey(normalizeEmail(address), pepper).toString("hex");
    console.log(`lifted ${String(lifted)} suppression(s) recipient_hash=${hash}`);
    if (lifted === 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
