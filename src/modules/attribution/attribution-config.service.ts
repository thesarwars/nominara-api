import { randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import type { AttributionConfig, AttributionConfigResponse, CreateAttributionConfigRequest } from "../../../contracts/attribution/index.js";
import { ConflictError, NotFoundError } from "../../api/errors/domain-errors.js";
import { loadEnv } from "../../config/env.js";
import { decryptField, encryptField } from "../../lib/crypto/envelope.js";
import { unwrapDek } from "../../lib/crypto/dek-unwrap.js";
import { hashSiteToken } from "../../lib/attribution/site-token.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { assertStepUpFresh } from "../../tenancy/step-up.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-113 - `GET`/`POST`/`DELETE /projects/{id}/attribution/config`, owning `attribution_configs`.
//
// ONE ACTIVE CONFIGURATION PER PROJECT (the partial unique index). DELETE disconnects rather than erasing: the row is kept as
// `disabled` so the token hash stays reserved and the history of "this project once had a beacon" survives, but the credential
// and its key id are WIPED in the same statement, so a disconnected configuration holds nothing that could be read back.
//
// `stale` is derived on read from the last event time, not stored: nothing sweeps the table, and a stored value would be wrong
// the moment after it was written. The credential column is never selected by any read path: the only trace a response may
// carry is the boolean `credentials_stored`.

const logger = new Logger("attribution-config");

/**
 * A configuration whose last event is older than this reads `stale` (`receiving` -> `stale`). The story names the state, not the
 * window: 24 hours is PROVISIONAL, one line to change once the owner decides.
 */
export const ATTRIBUTION_STALE_AFTER_HOURS = 24;

interface ConfigRow {
  id: string;
  project_id: string;
  method: "script" | "ga4";
  site_token: string;
  allowed_origins: string[];
  conversion_events: string[];
  ga4_property_id: string | null;
  credentials_stored: boolean;
  status: "pending" | "receiving" | "stale" | "disabled";
  first_event_at: Date | null;
  last_event_at: Date | null;
  created_at: Date;
}

const SELECT_CONFIG = `
  SELECT c.id, c.project_id, c.method, c.site_token, c.allowed_origins, c.conversion_events, c.ga4_property_id,
         (c.ga4_credentials_enc IS NOT NULL) AS credentials_stored,
         CASE WHEN c.status = 'receiving' AND c.last_event_at < now() - make_interval(hours => $3) THEN 'stale' ELSE c.status END AS status,
         c.first_event_at, c.last_event_at, c.created_at
    FROM attribution_configs c`;

function snippetFor(token: string): string {
  const base = loadEnv().OAUTH_REDIRECT_BASE_URL.replace(/\/+$/, "");
  // The tab keeps ONLY the AI source class the server answered for the landing, in sessionStorage (gone when the tab closes; no cookie, no
  // visitor id), and sends it with later events so a conversion on a later page still counts for the AI source (decision 86).
  const code =
    `(function(){var u="${base}/v1/ingest/attribution",t="${token}",k="nominara_src";` +
    `function p(b){b.site_token=t;b.landing_url=location.href;b.referrer=document.referrer;try{var c=sessionStorage.getItem(k);if(c)b.source_class=c}catch(e){}` +
    `return fetch(u,{method:"POST",keepalive:true,headers:{"content-type":"application/json"},body:JSON.stringify(b)})}` +
    `p({}).then(function(r){return r.json()}).then(function(j){var c=j&&j.data&&j.data.source_class;if(c)try{sessionStorage.setItem(k,c)}catch(e){}}).catch(function(){});` +
    `window.nominaraConversion=function(n,v){p({conversion:{name:n,value:v}})}})()`;
  return `<script>${code}</script>`;
}

function present(row: ConfigRow): AttributionConfig {
  return {
    id: row.id,
    project_id: row.project_id,
    method: row.method,
    site_token: row.site_token,
    allowed_origins: row.allowed_origins,
    conversion_events: row.conversion_events,
    ga4_property_id: row.ga4_property_id,
    credentials_stored: row.credentials_stored,
    status: row.status,
    receiving: row.status === "receiving",
    first_event_at: row.first_event_at?.toISOString() ?? null,
    last_event_at: row.last_event_at?.toISOString() ?? null,
    snippet: row.method === "script" ? snippetFor(row.site_token) : null,
    created_at: row.created_at.toISOString(),
  };
}

@Injectable()
export class AttributionConfigService {
  private tx(): NonNullable<ReturnType<typeof currentTenantStore>> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("AttributionConfigService requires an active tenant context");
    return store;
  }

  private async assertProject(workspaceId: string, projectId: string): Promise<void> {
    const found = await this.tx().client.query("SELECT 1 FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL", [projectId, workspaceId]);
    if (found.rowCount === 0) throw new NotFoundError({ message: "no such project" });
  }

  async get(workspaceId: string, projectId: string): Promise<AttributionConfigResponse> {
    await this.assertProject(workspaceId, projectId);
    const found = await this.tx().client.query<ConfigRow>(`${SELECT_CONFIG} WHERE c.project_id = $1 AND c.workspace_id = $2 AND c.status <> 'disabled'`, [projectId, workspaceId, ATTRIBUTION_STALE_AFTER_HOURS]);
    const row = found.rows[0];
    return { config: row === undefined ? null : present(row) };
  }

  async create(workspaceId: string, actorId: string, projectId: string, lastStrongAuthAt: Date | null, input: CreateAttributionConfigRequest): Promise<AttributionConfig> {
    assertStepUpFresh(lastStrongAuthAt);
    await this.assertProject(workspaceId, projectId);
    const { client } = this.tx();
    const id = uuidV7();
    // The workspace id rides in the token (see site-token.ts): it only selects whose row-level security the ingest lookup runs under.
    const token = `nat_${workspaceId}_${randomBytes(24).toString("base64url")}`;

    let credentials: { enc: string; dekId: string } | undefined;
    if (input.method === "ga4") credentials = await this.seal(workspaceId, id, input.ga4_credentials);

    try {
      await client.query(
        `INSERT INTO attribution_configs (id, workspace_id, project_id, method, site_token, site_token_hash, allowed_origins, ga4_property_id,
                                          ga4_credentials_enc, dek_id, conversion_events, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, workspaceId, projectId, input.method, token, hashSiteToken(token), input.allowed_origins ?? [], input.method === "ga4" ? input.ga4_property_id : null, credentials?.enc ?? null, credentials?.dekId ?? null, input.conversion_events ?? [], actorId],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ConflictError({ message: "this project already has an active attribution configuration" });
      throw error;
    }
    incrementCounter("nominara_attribution_config_changes_total", { change: "created", method: input.method });
    // Workspace ID only: never the token, the origins or anything about the credential.
    logger.log({ span: "attribution.config.create", workspace_id: workspaceId, method: input.method });
    const created = await client.query<ConfigRow>(`${SELECT_CONFIG} WHERE c.id = $1 AND c.workspace_id = $2`, [id, workspaceId, ATTRIBUTION_STALE_AFTER_HOURS]);
    return present(created.rows[0]!);
  }

  async disconnect(workspaceId: string, projectId: string, lastStrongAuthAt: Date | null): Promise<void> {
    assertStepUpFresh(lastStrongAuthAt);
    await this.assertProject(workspaceId, projectId);
    const gone = await this.tx().client.query(
      `UPDATE attribution_configs SET status = 'disabled', ga4_credentials_enc = NULL, dek_id = NULL
        WHERE project_id = $1 AND workspace_id = $2 AND status <> 'disabled' RETURNING id`,
      [projectId, workspaceId],
    );
    if (gone.rowCount === 0) throw new NotFoundError({ message: "this project has no active attribution configuration" });
    incrementCounter("nominara_attribution_config_changes_total", { change: "disconnected", method: "any" });
    logger.log({ span: "attribution.config.disconnect", workspace_id: workspaceId });
  }

  /** Envelope-encrypts a provider credential under the workspace's active DEK, bound by AAD to this workspace, table, column and row. */
  private async seal(workspaceId: string, configId: string, plaintext: string): Promise<{ enc: string; dekId: string }> {
    const key = await this.tx().client.query<{ dek_id: string; wrapped_dek: Buffer }>(
      "SELECT dek_id, wrapped_dek FROM workspace_keys WHERE workspace_id = $1 AND status = 'active' ORDER BY activated_at DESC LIMIT 1",
      [workspaceId],
    );
    const row = key.rows[0];
    // Every workspace is provisioned a DEK at creation, so its absence is a broken invariant: fail closed with a 500, never store in clear.
    if (row === undefined) throw new Error("attribution: the workspace has no active data-encryption key");
    const dek = unwrapDek(row.wrapped_dek, Buffer.from(loadEnv().WORKSPACE_DEK_WRAPPING_KEY, "base64"));
    const aad = { workspaceId, table: "attribution_configs", column: "ga4_credentials_enc", rowId: configId };
    const enc = encryptField(plaintext, dek, row.dek_id, aad);
    // A seal that cannot be opened is worse than no seal: prove the round trip before the row is written.
    if (decryptField(enc, dek, aad) !== plaintext) throw new Error("attribution: credential seal failed its round trip");
    return { enc, dekId: row.dek_id };
  }
}
