import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import type { PortalTelemetryResponse } from "../../../contracts/portal/index.js";
import { assertPortalTab } from "../../lib/portal/portal-view.js";
import type { PortalSessionContext } from "../../api/decorators/portal-route.decorator.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { PORTAL_SESSION_TTL_SECONDS } from "./portal-cookie.js";

/** A beat that adds no tab writes only if the duration has moved by at least this much, so a chatty client costs at most a write per interval. */
const MIN_DURATION_STEP_MS = 5_000;

// Owner decision 71 (c) — owns the telemetry columns of `share_token_views` (pages_viewed, duration_ms); the row itself is written at
// the session mint by ShareTokensService.consumeView, which is why its id can ride in the cookie.
//
// WHICH VIEW is never the request's say: it is the cookie's `view_id`, and the UPDATE is additionally pinned to the cookie's token and to
// `workspace_id = app.current_workspace()`, so a view of another token (or tenant) is not writable even through a cookie that names it.
// WHAT is recorded: the tab (already checked against the token's tabs) and a duration the SERVER measures (now minus the view's start,
// never more than the session's own lifetime): a client cannot report time it did not spend.
// WHERE: the portal's own transaction is READ ONLY on the SELECT-only role, so the write runs on the app pool in its own short tenant
// transaction. Nothing external is awaited inside it.
@Injectable()
export class PortalTelemetryService {
  private readonly logger = new Logger(PortalTelemetryService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(session: PortalSessionContext, tab: string): Promise<PortalTelemetryResponse> {
    const started = performance.now();
    assertPortalTab(session, tab);
    let outcome = "no_view";
    try {
      if (session.viewId === null) return { recorded: false };
      const viewId = session.viewId;
      const client = await this.pool.connect();
      try {
        const updated = await withTenantContext(client, { workspaceId: session.workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
          tx.query(
            `UPDATE share_token_views
                SET pages_viewed = CASE WHEN $3::text = ANY(pages_viewed) THEN pages_viewed ELSE array_append(pages_viewed, $3::text) END,
                    duration_ms  = GREATEST(COALESCE(duration_ms, 0), LEAST(floor(extract(epoch FROM (now() - viewed_at)) * 1000)::bigint, $4::bigint)::int)
              WHERE id = $1 AND share_token_id = $2 AND workspace_id = app.current_workspace()
                AND (NOT ($3::text = ANY(pages_viewed))
                     OR duration_ms IS NULL
                     OR LEAST(floor(extract(epoch FROM (now() - viewed_at)) * 1000)::bigint, $4::bigint) - duration_ms >= $5::bigint)`,
            [viewId, session.tokenId, tab, PORTAL_SESSION_TTL_SECONDS * 1000, MIN_DURATION_STEP_MS],
          ),
        );
        const recorded = (updated.rowCount ?? 0) === 1;
        outcome = recorded ? "recorded" : "unchanged";
        return { recorded };
      } finally {
        client.release();
      }
    } finally {
      incrementCounter("nominara_portal_telemetry_beats_total", { outcome });
      // Workspace, token and view IDs only: no address, no agent, no tab content.
      this.logger.log({ span: "portal.telemetry", workspace_id: session.workspaceId, token_id: session.tokenId, outcome, duration_ms: Math.round(performance.now() - started) });
    }
  }
}
