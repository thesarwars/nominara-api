import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { z } from "zod";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { BREAKGLASS_ROLE } from "../../db/conventions.js";
import { WORKSPACE_GUC, SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { incrementCounter, observeValue } from "../telemetry/metrics.js";
import type { Pager } from "./dead-letter.js";

// STORY-010 AC2 / owner decision 107(a) — a login by the break-glass role is detected by a watcher, written to the
// hash-chained audit_log, and emailed as a critical alert through the existing Pager (Resend; there is no pager service).
//
// WHY A WATCHER. The `ON login` event trigger of migration 0005 can only RAISE LOG: a break-glass connection carries no
// workspace and the trigger cannot append to a per-workspace chain. So the monitor driver (STORY-179) polls
// pg_stat_activity once a minute for sessions of the role. ⚠ A session that opens and closes between two ticks is NOT
// seen by polling; the RAISE LOG line of the trigger remains the record of that case. The role's connection limit of two
// and its time-boxed credential bound the exposure.
//
// WHERE THE AUDIT ROW GOES. audit_log is chained per workspace_id (uuid NOT NULL, no foreign key). Platform-level events
// have no workspace, so they extend ONE reserved chain keyed on the nil uuid, which the daily verifier walks like any
// other (it enumerates `SELECT DISTINCT workspace_id FROM audit_log`).
//
// ONCE PER SESSION. A session is keyed `pid:backend_start` (just `pid` where backend_start is not visible to the
// reading role). The alert and the audit row are tracked separately: the alert is a synchronous pager call and is
// marked first; the audit write can fail, and is retried on the next tick WITHOUT a second alert. A row written but
// not yet marked (a crash) is not written again: the request id is checked first.

const logger = new Logger("breakglass-monitor");
const tracer = trace.getTracer("nominara-api");

export const BREAKGLASS_ALERT_NAME = "breakglass_login";
export const BREAKGLASS_AUDIT_ACTION = "auth.breakglass_login";
/** The reserved audit chain for events that belong to no workspace. */
export const PLATFORM_AUDIT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

export interface BreakglassSession {
  readonly pid: number;
  /** null when the reading role cannot see it. */
  readonly backendStartMs: number | null;
}

export const breakglassStateSchema = z
  .object({
    sessions: z.record(z.string(), z.object({ firstSeenMs: z.number(), alerted: z.boolean(), audited: z.boolean() }).strict()),
  })
  .strict();
export type BreakglassState = z.infer<typeof breakglassStateSchema>;
export const EMPTY_BREAKGLASS_STATE: BreakglassState = { sessions: {} };

export const sessionIdOf = (s: BreakglassSession): string => (s.backendStartMs === null ? String(s.pid) : `${s.pid}:${s.backendStartMs}`);

export interface BreakglassLoginMonitorOptions {
  readonly pager: Pager;
  readonly clock?: () => number;
  /** Writes the audit row. Throws on failure; the monitor retries on the next observation. */
  readonly audit: (session: BreakglassSession, sessionId: string) => Promise<void>;
}

export class BreakglassLoginMonitor {
  private readonly pager: Pager;
  private readonly clock: () => number;
  private readonly audit: BreakglassLoginMonitorOptions["audit"];
  private seen = new Map<string, { firstSeenMs: number; alerted: boolean; audited: boolean }>();

  constructor(options: BreakglassLoginMonitorOptions) {
    this.pager = options.pager;
    this.clock = options.clock ?? (() => Date.now());
    this.audit = options.audit;
  }

  importState(state: BreakglassState): void {
    this.seen = new Map(Object.entries(state.sessions).map(([key, value]) => [key, { ...value }]));
  }

  exportState(): BreakglassState {
    return { sessions: Object.fromEntries([...this.seen].map(([key, value]) => [key, { ...value }])) };
  }

  /** The full current list of live sessions of the role. A session absent from it has ended and is forgotten. */
  async observe(sessions: readonly BreakglassSession[]): Promise<void> {
    await tracer.startActiveSpan("queue.breakglass_watch", async (span) => {
      try {
        const live = new Map(sessions.map((s) => [sessionIdOf(s), s]));
        for (const key of [...this.seen.keys()]) if (!live.has(key)) this.seen.delete(key);
        span.setAttribute("nominara.breakglass.live_sessions", live.size);

        for (const [key, session] of live) {
          let entry = this.seen.get(key);
          if (entry === undefined) {
            entry = { firstSeenMs: this.clock(), alerted: false, audited: false };
            this.seen.set(key, entry);
            incrementCounter("nominara_breakglass_login_detected_total");
            if (session.backendStartMs !== null) {
              observeValue("nominara_breakglass_detection_lag_seconds", Math.max(0, (this.clock() - session.backendStartMs) / 1000));
            }
          }
          if (!entry.alerted) {
            entry.alerted = true;
            // Fixed text plus IDs: this is emailed verbatim (see Pager).
            this.pager.page("the break-glass database role has an open session", {
              alertName: BREAKGLASS_ALERT_NAME,
              severity: "critical",
              sessionId: key,
              pid: session.pid,
              role: BREAKGLASS_ROLE,
            });
            incrementCounter("nominara_breakglass_alert_total");
          }
          if (!entry.audited) {
            try {
              await this.audit(session, key);
              entry.audited = true;
              incrementCounter("nominara_breakglass_audit_total", { outcome: "written" });
            } catch (error) {
              incrementCounter("nominara_breakglass_audit_total", { outcome: "failed" });
              span.setStatus({ code: SpanStatusCode.ERROR });
              logger.error(`break-glass audit row could not be written for session ${key}; retrying next tick: ${error instanceof Error ? error.name : "unknown error"}`);
            }
          }
        }
        logger.log({ message: "break-glass watch", liveSessions: live.size });
      } finally {
        span.end();
      }
    });
  }
}

/** Live sessions of the break-glass role (never this connection). Needs only visibility of pid and usename. */
export async function readBreakglassSessions(db: Pick<ClientBase, "query">): Promise<BreakglassSession[]> {
  const result = await db.query<{ pid: number; backend_start: Date | null }>(
    "SELECT pid, backend_start FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
    [BREAKGLASS_ROLE],
  );
  return result.rows.map((row) => ({ pid: row.pid, backendStartMs: row.backend_start === null ? null : new Date(row.backend_start).getTime() }));
}

const chain = new AuditChainService();

/**
 * Appends the critical audit row on the platform chain, inside a savepoint so a failure cannot poison the election
 * transaction it runs in. The workspace context is transaction-local (set_config is_local = true) and is cleared by the
 * caller's COMMIT.
 */
export async function recordBreakglassLogin(db: ClientBase, session: BreakglassSession, sessionId: string): Promise<void> {
  const requestId = `breakglass-login:${sessionId}`;
  await db.query("SAVEPOINT breakglass_audit");
  try {
    await db.query("SELECT set_config($1, $2, true)", [WORKSPACE_GUC, PLATFORM_AUDIT_WORKSPACE_ID]);
    const existing = await db.query("SELECT 1 AS one FROM audit_log WHERE workspace_id = $1 AND request_id = $2 LIMIT 1", [PLATFORM_AUDIT_WORKSPACE_ID, requestId]);
    if ((existing.rowCount ?? existing.rows.length) === 0) {
      await chain.append(db, {
        workspaceId: PLATFORM_AUDIT_WORKSPACE_ID,
        actorType: "system",
        actorId: SYSTEM_ACTOR_ID,
        actorIp: null,
        actorUa: "worker:breakglass-monitor",
        action: BREAKGLASS_AUDIT_ACTION,
        resourceType: "database_role",
        resourceId: null,
        beforeState: null,
        afterState: { role: BREAKGLASS_ROLE, pid: session.pid, backend_start_ms: session.backendStartMs },
        requestId,
        supportGrantId: null,
        severity: "critical",
      });
    }
    await db.query("RELEASE SAVEPOINT breakglass_audit");
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT breakglass_audit");
    throw error;
  }
}
