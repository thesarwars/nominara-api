import type { ClientBase } from "pg";
import { resolveEntitlements } from "../entitlements/resolution.js";
import { DAILY_CAP_ENTITLEMENT, type DailyCapAction } from "./daily-cap.js";

/**
 * The two customer-visible DAILY meters, for `GET /billing/usage` (STORY-096 AC15), `GET /billing/wallet` and `GET /tools` (STORY-095 AC12, owner decision 106(d)),
 * so the three reads cannot disagree. `used` is today's (UTC) row of credit_daily_counters, 0 with no row; the cap is the plan's CURRENT entitlement, not the row's
 * `limit_count`, which holds the limit the day's last write used (a mid-day upgrade lifts the cap at once). `null` is no cap (a paid plan), `0` is a tier that has none.
 * Read-only: no row is created.
 */
export async function readDailyMeters(client: ClientBase, workspaceId: string): Promise<Record<DailyCapAction, { used: number; cap: number | null }>> {
  const todays = await client.query<{ action_code: string; used_count: number }>(
    `SELECT action_code, used_count FROM credit_daily_counters
      WHERE workspace_id = $1 AND utc_date = (now() AT TIME ZONE 'UTC')::date`,
    [workspaceId],
  );
  const entitlements = (await resolveEntitlements(client, workspaceId)).entitlements;
  const meter = (action: DailyCapAction): { used: number; cap: number | null } => {
    const value = entitlements[DAILY_CAP_ENTITLEMENT[action]]?.value;
    return {
      used: todays.rows.find((r) => r.action_code === action)?.used_count ?? 0,
      cap: typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null,
    };
  };
  return { lookup: meter("lookup"), nlp_command: meter("nlp_command") };
}
