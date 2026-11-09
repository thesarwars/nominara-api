import { timingSafeEqual } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Pool } from "pg";
import {
  GSC_FRONTIER_COPY,
  GSC_READ_ONLY_SCOPE,
  type GscConnection,
  type GscOauthCallbackQuery,
  type GscOauthStartRequest,
  type GscOauthStartResponse,
  type GscSyncResponse,
} from "../../../contracts/integrations/index.js";
import { API_VERSION_PREFIX } from "../../api/configure-app.js";
import {
  ConflictError,
  DegradedError,
  DomainNotVerifiedError,
  NotFoundError,
  ValidationFailedError,
} from "../../api/errors/domain-errors.js";
import { loadEnv } from "../../config/env.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { hashBinding, newBindingValue } from "../../lib/auth/oauth-state.js";
import { activeDek, sealSecret } from "../../lib/gsc/credentials.js";
import { parseGscProperty, propertyMatchesDomain } from "../../lib/gsc/property.js";
import { GSC_CLIENT, GscQuotaError, GscSourceError, GscUnauthorizedError, type GscClient } from "../../lib/gsc/port.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { afterCommit, currentTenantStore, withTenantContext } from "../../tenancy/tenant-context.js";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { GSC_STATE_TTL_MS, signGscState, verifyGscState } from "./gsc-oauth-state.js";

// STORY-115 - the Search Console connection: `POST /integrations/gsc/oauth/start`, `GET .../oauth/callback`, `GET`/`DELETE
// /integrations/gsc/{id}` and `POST /integrations/gsc/{id}/sync`. Owns `gsc_connections` (the sync job and the correlation read use it too,
// as `attribution_configs` is shared by its ingest path).
//
// THE TRUST POSTURE, in order of what a reviewer should check:
//   1. The authorisation asks for the read-only scope only (the adapter builds the URL; the callback ALSO refuses any grant carrying
//      another scope, so a write scope is never held even if Google or a proxy widened the request).
//   2. The property must be the project's own domain, on a VERIFIED project, checked at start AND again at the callback against the
//      properties the Google account really holds. A mismatch is a 400 and nothing is stored: wrong-site data cannot be told from right.
//   3. Tokens are envelope-encrypted before the row is written and are in no response, log line or span.
//   4. NO NETWORK CALL INSIDE A TRANSACTION (ADR-0003). The token exchange and property list run with none open; the connection is then
//      written in one short transaction.
//
// ONE ACTIVE CONNECTION PER PROJECT (`ux_gsc_project`). A connection whose credential was revoked (`unauthorized`) is re-authorised IN
// PLACE, so its synced history and watermark are kept; any other active connection is a 409.

const logger = new Logger("gsc-connection");
const tracer = trace.getTracer("nominara-api");

interface ConnectionRow {
  id: string;
  project_id: string;
  property_url: string;
  property_type: "domain" | "url_prefix";
  health_status: GscConnection["health_status"];
  last_error: string | null;
  last_sync_date: string | null;
  last_sync_at: Date | null;
  backfill_completed: boolean;
  created_at: Date;
}

const SELECT_CONNECTION = `
  SELECT g.id, g.project_id, g.property_url, g.property_type, g.health_status, g.last_error, g.last_sync_date::text AS last_sync_date,
         g.last_sync_at, g.backfill_completed, g.created_at
    FROM gsc_connections g`;

function present(row: ConnectionRow): GscConnection {
  return {
    id: row.id,
    project_id: row.project_id,
    property_url: row.property_url,
    property_type: row.property_type,
    health_status: row.health_status,
    last_error: row.last_error,
    last_sync_date: row.last_sync_date,
    last_sync_at: row.last_sync_at?.toISOString() ?? null,
    backfill_completed: row.backfill_completed,
    frontier_note: GSC_FRONTIER_COPY,
    created_at: row.created_at.toISOString(),
  };
}

const invalid = (message: string, path: string): InstanceType<typeof ValidationFailedError> =>
  new ValidationFailedError({ message, details: { issues: [{ path: [path], message }] } });

/** The one answer for any callback that is not a clean, bound, unexpired, successful grant: it must not say which part was wrong. */
const refused = (): InstanceType<typeof ValidationFailedError> => invalid("search console authorisation was not completed", "state");

function bindingMatches(cookie: string | undefined, expectedHex: string): boolean {
  if (cookie === undefined || cookie === "") return false;
  const given = hashBinding(cookie);
  const expected = Buffer.from(expectedHex, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

@Injectable()
export class GscService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(GSC_CLIENT) private readonly google: GscClient,
    @Inject(QueueProducer) private readonly queues: Pick<QueueProducer, "enqueueTenantJob">,
  ) {}

  private tx(): NonNullable<ReturnType<typeof currentTenantStore>> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("GscService requires an active tenant context");
    return store;
  }

  private redirectUri(): string {
    return new URL(`/${API_VERSION_PREFIX}/integrations/gsc/oauth/callback`, loadEnv().OAUTH_REDIRECT_BASE_URL).toString();
  }

  // ---- start --------------------------------------------------------------------------------------------------------------------
  async start(workspaceId: string, actorId: string, input: GscOauthStartRequest): Promise<{ readonly body: GscOauthStartResponse; readonly bindingValue: string }> {
    const property = parseGscProperty(input.property_url);
    if (property === null) throw invalid("property_url must be a Search Console property: sc-domain:example.com or an https:// URL prefix", "property_url");
    const { client } = this.tx();
    const project = await client.query<{ root_domain: string; domain_verified_at: Date | null }>(
      "SELECT root_domain, domain_verified_at FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
      [input.project_id, workspaceId],
    );
    const row = project.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such project" });
    if (row.domain_verified_at === null) throw new DomainNotVerifiedError({ message: "verify the project's domain before connecting Search Console" });
    if (!propertyMatchesDomain(property, row.root_domain)) {
      incrementCounter("nominara_gsc_connect_total", { outcome: "property_mismatch" });
      throw invalid("that Search Console property does not belong to this project's domain", "property_url");
    }
    const active = await client.query<{ health_status: string }>(
      "SELECT health_status FROM gsc_connections WHERE project_id = $1 AND workspace_id = $2 AND revoked_at IS NULL",
      [input.project_id, workspaceId],
    );
    if (active.rows[0] !== undefined && active.rows[0].health_status !== "unauthorized") {
      throw new ConflictError({ message: "this project already has an active Search Console connection" });
    }

    const bindingValue = newBindingValue();
    const expiresAtMs = Date.now() + GSC_STATE_TTL_MS;
    const state = signGscState({ w: workspaceId, p: input.project_id, a: actorId, u: property.normalised, e: expiresAtMs, b: hashBinding(bindingValue).toString("hex") }, loadEnv().OAUTH_STATE_SECRET);
    incrementCounter("nominara_gsc_connect_total", { outcome: "started" });
    logger.log({ event: "gsc.connect.started", workspace_id: workspaceId, property_type: property.type });
    return {
      body: { authorization_url: this.google.authorizationUrl({ state, redirectUri: this.redirectUri() }), state_expires_at: new Date(expiresAtMs).toISOString(), property_type: property.type },
      bindingValue,
    };
  }

  // ---- callback (public: Google redirects the browser here) -----------------------------------------------------------------------
  async callback(query: GscOauthCallbackQuery, bindingCookie: string | undefined): Promise<GscConnection> {
    return tracer.startActiveSpan("gsc.connect.callback", async (span) => {
      let outcome = "refused";
      try {
        const state = verifyGscState(query.state, loadEnv().OAUTH_STATE_SECRET, Date.now());
        if (state === null || !bindingMatches(bindingCookie, state.b) || query.error !== undefined || query.code === undefined) throw refused();
        const property = parseGscProperty(state.u);
        if (property === null) throw refused();

        // The network, with no transaction open.
        let tokens;
        try {
          tokens = await this.google.exchangeCode({ code: query.code, redirectUri: this.redirectUri() });
        } catch (error) {
          if (error instanceof GscUnauthorizedError) throw refused();
          if (error instanceof GscQuotaError || error instanceof GscSourceError) throw new DegradedError({ message: "Google could not be reached to complete the connection" });
          throw error;
        }
        // FAIL CLOSED ON SCOPE: exactly the read-only scope, nothing more.
        if (tokens.scopes.length === 0 || tokens.scopes.some((scope) => scope !== GSC_READ_ONLY_SCOPE)) {
          outcome = "scope_refused";
          throw refused();
        }
        if (tokens.refreshToken === null) throw refused();
        let held;
        try {
          held = await this.google.listProperties(tokens.accessToken);
        } catch (error) {
          if (error instanceof GscUnauthorizedError) throw refused();
          throw new DegradedError({ message: "Google could not be reached to complete the connection" });
        }
        if (!held.some((listed) => parseGscProperty(listed.siteUrl)?.normalised === property.normalised)) {
          outcome = "property_not_held";
          throw refused();
        }

        const connection = await this.persist(state.w, state.a, state.p, property, tokens);
        outcome = "connected";
        return connection;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.setAttribute("gsc.connect.outcome", outcome);
        span.end();
        incrementCounter("nominara_gsc_connect_total", { outcome });
      }
    });
  }

  private async persist(
    workspaceId: string,
    actorId: string,
    projectId: string,
    property: NonNullable<ReturnType<typeof parseGscProperty>>,
    tokens: { accessToken: string; refreshToken: string | null; expiresInSeconds: number; scopes: readonly string[] },
  ): Promise<GscConnection> {
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId }, async (tx) => {
        // Re-validated inside the transaction: the project may have changed or lost its verification since the flow began.
        const project = await tx.query<{ root_domain: string; domain_verified_at: Date | null }>(
          "SELECT root_domain, domain_verified_at FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
          [projectId, workspaceId],
        );
        const row = project.rows[0];
        if (row === undefined) throw new NotFoundError({ message: "no such project" });
        if (row.domain_verified_at === null) throw new DomainNotVerifiedError({ message: "verify the project's domain before connecting Search Console" });
        if (!propertyMatchesDomain(property, row.root_domain)) throw invalid("that Search Console property does not belong to this project's domain", "property_url");

        const existing = await tx.query<{ id: string; health_status: string }>(
          "SELECT id, health_status FROM gsc_connections WHERE project_id = $1 AND workspace_id = $2 AND revoked_at IS NULL FOR UPDATE",
          [projectId, workspaceId],
        );
        const current = existing.rows[0];
        if (current !== undefined && current.health_status !== "unauthorized") throw new ConflictError({ message: "this project already has an active Search Console connection" });

        const id = current?.id ?? uuidV7();
        const dek = await activeDek(tx, workspaceId);
        const access = sealSecret(dek, workspaceId, id, "credentials_enc", tokens.accessToken);
        const refresh = sealSecret(dek, workspaceId, id, "refresh_enc", tokens.refreshToken!);
        if (current === undefined) {
          try {
            await tx.query(
              `INSERT INTO gsc_connections (id, workspace_id, project_id, property_url, property_type, credentials_enc, dek_id, refresh_enc, scopes, token_expires_at, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[], now() + make_interval(secs => $10::int), $11)`,
              [id, workspaceId, projectId, property.normalised, property.type, access, dek.dekId, refresh, [...tokens.scopes], tokens.expiresInSeconds, actorId],
            );
          } catch (error) {
            if ((error as { code?: string }).code === "23505") throw new ConflictError({ message: "this project already has an active Search Console connection" });
            throw error;
          }
        } else {
          // Re-authorised in place: the credential is replaced, the watermark and every synced row are kept.
          await tx.query(
            `UPDATE gsc_connections
                SET property_url = $3, property_type = $4, credentials_enc = $5, dek_id = $6, refresh_enc = $7, scopes = $8::text[],
                    token_expires_at = now() + make_interval(secs => $9::int), health_status = 'unknown', last_error = NULL
              WHERE id = $1 AND workspace_id = $2`,
            [id, workspaceId, property.normalised, property.type, access, dek.dekId, refresh, [...tokens.scopes], tokens.expiresInSeconds],
          );
        }
        await new AuditChainService().append(tx, {
          workspaceId,
          actorType: "user",
          actorId,
          actorIp: null,
          actorUa: null,
          action: current === undefined ? "gsc.connected" : "gsc.reauthorised",
          resourceType: "gsc_connection",
          resourceId: id,
          beforeState: current === undefined ? null : { health_status: current.health_status },
          afterState: { project_id: projectId, property_type: property.type, scopes: [...tokens.scopes] },
          requestId: `gsc.connect:${uuidV7()}`,
          supportGrantId: null,
          severity: "notice",
        });
        const day = (await tx.query<{ day: string }>("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day")).rows[0]!.day;
        this.enqueueSync(workspaceId, id, day);
        const read = await tx.query<ConnectionRow>(`${SELECT_CONNECTION} WHERE g.id = $1 AND g.workspace_id = $2`, [id, workspaceId]);
        return present(read.rows[0]!);
      });
    } finally {
      client.release();
    }
  }

  /** After COMMIT. A lost enqueue only delays the first sync: the daily cadence picks the connection up, so it is logged and counted, never thrown. */
  private enqueueSync(workspaceId: string, connectionId: string, day: string): void {
    afterCommit(() => {
      void this.queues.enqueueTenantJob("gsc.sync", workspaceId, { connectionId }, { idempotencyKey: `gsc:${connectionId}:${day}` }).catch((error: unknown) => {
        incrementCounter("nominara_gsc_sync_enqueue_failed_total");
        logger.warn({ event: "gsc.sync.not_enqueued", workspace_id: workspaceId, connection_id: connectionId, error: error instanceof Error ? error.name : "unknown" });
      });
    });
  }

  // ---- read / disconnect / sync -------------------------------------------------------------------------------------------------
  async get(connectionId: string): Promise<GscConnection> {
    const { client } = this.tx();
    const found = await client.query<ConnectionRow>(
      `${SELECT_CONNECTION}
        WHERE g.id = $1 AND g.workspace_id = app.current_workspace()
          AND (cardinality(app.current_scope_projects()) = 0 OR g.project_id = ANY(app.current_scope_projects()))`,
      [connectionId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such Search Console connection" });
    return present(row);
  }

  async disconnect(workspaceId: string, connectionId: string): Promise<void> {
    const { client } = this.tx();
    // The credential is wiped in the same statement; `credentials_enc` and `dek_id` are NOT NULL, so they hold the empty string. Every
    // synced `gsc_daily` row stays: disconnecting stops the data arriving, it does not erase what already arrived.
    const gone = await client.query(
      `UPDATE gsc_connections SET revoked_at = now(), health_status = 'revoked', credentials_enc = '', refresh_enc = NULL, dek_id = '', token_expires_at = NULL
        WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING id`,
      [connectionId, workspaceId],
    );
    if (gone.rowCount === 0) throw new NotFoundError({ message: "no such active Search Console connection" });
    incrementCounter("nominara_gsc_connect_total", { outcome: "disconnected" });
    logger.log({ event: "gsc.connect.disconnected", workspace_id: workspaceId });
  }

  async sync(workspaceId: string, connectionId: string): Promise<GscSyncResponse> {
    const { client } = this.tx();
    const found = await client.query<{ revoked_at: Date | null; day: string }>(
      "SELECT revoked_at, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM gsc_connections WHERE id = $1 AND workspace_id = $2",
      [connectionId, workspaceId],
    );
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such Search Console connection" });
    if (row.revoked_at !== null) throw new ConflictError({ message: "this Search Console connection was disconnected" });
    // Zero credits and no call to Google: the request only queues the job, keyed per connection and day.
    this.enqueueSync(workspaceId, connectionId, row.day);
    incrementCounter("nominara_gsc_manual_sync_total");
    return { connection_id: connectionId, queued: true };
  }
}
