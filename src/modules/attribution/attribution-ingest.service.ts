import { Inject, Injectable, Logger } from "@nestjs/common";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { Pool } from "pg";
import type { IngestAttributionRequest, IngestAttributionResponse } from "../../../contracts/attribution/index.js";
import { NotFoundError, RateLimitedError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { classifyReferrer, countryFromHeader, deviceFromUserAgent, InvalidLandingUrlError, normalizeLanding, withoutQueryAndFragment } from "../../lib/attribution/beacon-dimensions.js";
import { hashSiteToken, workspaceOfSiteToken } from "../../lib/attribution/site-token.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { tenantKey } from "../../lib/cache/valkey-keys.js";
import { incrementCounter, observeValue } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";

// STORY-113 - POST /ingest/attribution. PUBLIC and aggregate-at-ingest.
//
//   1. resolve the configuration by token hash, inside the workspace the token names (read-only, short)
//   2. check the request's Origin against the configuration's allow-list; refuse otherwise
//   3. rate-limit THIS configuration (outside any transaction: ADR-0003, no network I/O inside one)
//   4. classify the referrer, normalise and hash the landing URL
//   5. UPSERT the daily counter and touch the configuration's receiving state, in one short transaction
//   6. answer 202
//
// WHAT IT NEVER TOUCHES. The request's address, `X-Forwarded-For`, cookies and the user agent are not stored, logged or passed to any
// query: the agent is reduced to one of three device categories and the edge's country header to two letters, in beacon-dimensions.ts,
// and nothing else of the request reaches this file. The writes are the daily upsert and the configuration's receiving timestamps,
// and the integration test captures every statement to prove it.
//
// ONE NEUTRAL REFUSAL (404) for an unknown, malformed, disconnected or deleted-project token AND for a forged origin, so the route is
// not an oracle for which tokens exist or what they allow (the origin refusal is counted separately). A spent budget is 429.
//
// NO NETWORK CALL (KAD-06): the only I/O is Postgres and the cache's counter. Nothing waits on an engine, a provider or a crawl target.

const logger = new Logger("attribution-ingest");
const tracer = trace.getTracer("nominara-api");

/**
 * Events per configuration per minute. The story requires a per-configuration limit and states no number: this is PROVISIONAL
 * (one line to change once the owner decides), sized well above a busy page's AI-referred sessions.
 */
export const ATTRIBUTION_INGEST_LIMIT_PER_MINUTE = 600;
const RATE_WINDOW_MS = 60_000;

export interface IngestRequestFacts {
  readonly origin: string | undefined;
  readonly userAgent: string | undefined;
  readonly countryHeader: string | undefined;
}

interface ResolvedConfig {
  id: string;
  allowed_origins: string[];
  conversion_events: string[];
}

/** Origin and token refusals are the same answer: the route is not an oracle for which tokens exist or which origins they allow. */
const originRefusal = (): InstanceType<typeof NotFoundError> => new NotFoundError({ message: "this beacon is not active" });
const neutralRefusal = (): InstanceType<typeof NotFoundError> => new NotFoundError({ message: "this beacon is not active" });

@Injectable()
export class AttributionIngestService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CACHE) private readonly cache: Cache,
  ) {}

  ingest(body: IngestAttributionRequest, facts: IngestRequestFacts): Promise<IngestAttributionResponse> {
    return tracer.startActiveSpan("attribution.ingest", async (span) => {
      const started = Date.now();
      let outcome = "error";
      let workspaceId: string | undefined;
      try {
        workspaceId = workspaceOfSiteToken(body.site_token);
        const result = await this.run(body, facts, workspaceId);
        outcome = result.recorded ? "recorded" : "not_ai_referral";
        return result;
      } catch (error) {
        outcome = error instanceof NotFoundError ? "unknown_token" : error instanceof RateLimitedError ? "rate_limited" : error instanceof ValidationFailedError ? "invalid" : "error";
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.setAttribute("attribution.outcome", outcome);
        span.end();
        incrementCounter("nominara_attribution_ingest_total", { outcome });
        observeValue("nominara_attribution_ingest_duration_ms", Date.now() - started, { outcome });
        // Workspace ID and outcome only: never the token, origin, landing URL, agent or any address.
        logger.log({ span: "attribution.ingest", workspace_id: workspaceId ?? "unresolved", outcome, duration_ms: Date.now() - started });
      }
    });
  }

  private async run(body: IngestAttributionRequest, facts: IngestRequestFacts, workspaceId: string | undefined): Promise<IngestAttributionResponse> {
    if (workspaceId === undefined) throw neutralRefusal();
    const tokenHash = hashSiteToken(body.site_token);

    // Reject what is wrong with the PAYLOAD before any write, so a refusal leaves nothing behind.
    let landing: { url: string; hash: Buffer };
    try {
      // The query and fragment are cut BEFORE anything is hashed or stored: the snippet posts `location.href`, and a query can carry a
      // visitor's token or address. (The raw URL is still read, below, for its `utm_source` - read, never kept.)
      landing = normalizeLanding(withoutQueryAndFragment(body.landing_url));
    } catch (error) {
      if (error instanceof InvalidLandingUrlError) throw new ValidationFailedError({ message: error.message, details: { issues: [{ path: ["landing_url"], message: error.message }] } });
      throw error;
    }

    const config = await this.resolve(workspaceId, tokenHash);
    if (config === undefined) throw neutralRefusal();

    const origin = facts.origin?.toLowerCase();
    // An empty allow-list admits nothing: fail closed.
    if (origin === undefined || !config.allowed_origins.includes(origin)) {
      incrementCounter("nominara_attribution_origin_refusals_total");
      throw originRefusal();
    }

    await this.limit(workspaceId, config.id);

    const referrerClass = classifyReferrer(body.referrer, body.landing_url);
    // A conversion event is NOT a session: the landing beacon already counted the visit, so a conversion adds its count and value and
    // nothing else (otherwise one visitor who converts is two sessions and the conversion rate is understated). A conversion the
    // configuration does not list stores nothing at all.
    const isConversionEvent = body.conversion !== undefined;
    const counted = body.conversion !== undefined && config.conversion_events.includes(body.conversion.name);
    const written = await this.record(workspaceId, config.id, tokenHash, {
      landing,
      referrerClass,
      isConversionEvent,
      conversion: counted ? body.conversion : undefined,
      country: countryFromHeader(facts.countryHeader),
      device: deviceFromUserAgent(facts.userAgent),
    });
    if (!written) throw neutralRefusal();
    return { accepted: true, recorded: referrerClass !== "non_ai", conversion_counted: counted && referrerClass !== "non_ai" };
  }

  /** The configuration this token names: active, `script`-method, in a live workspace and a live project. Read-only. */
  private async resolve(workspaceId: string, tokenHash: Buffer): Promise<ResolvedConfig | undefined> {
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const found = await tx.query<ResolvedConfig>(
          `SELECT c.id, c.allowed_origins, c.conversion_events
             FROM attribution_configs c
             JOIN projects p ON p.id = c.project_id AND p.workspace_id = c.workspace_id AND p.deleted_at IS NULL
            WHERE c.site_token_hash = $1 AND c.workspace_id = app.current_workspace() AND c.status <> 'disabled' AND c.method = 'script'
              AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = c.workspace_id AND w.deleted_at IS NULL AND w.deletion_execute_at IS NULL)`,
          [tokenHash],
        );
        return found.rows[0];
      });
    } finally {
      client.release();
    }
  }

  /** A fixed one-minute window per configuration. Past the budget THIS configuration answers 429; no other key is touched. */
  private async limit(workspaceId: string, configId: string): Promise<void> {
    const key = tenantKey(cacheKeyNamespace(), workspaceId, "attribution", "ingest", configId);
    const count = await this.cache.increment(key, RATE_WINDOW_MS);
    if (count > ATTRIBUTION_INGEST_LIMIT_PER_MINUTE) {
      const remaining = await this.cache.timeToLiveMs(key);
      throw new RateLimitedError({ message: "this configuration is receiving too many events; try again shortly", details: { retry_after_ms: remaining ?? RATE_WINDOW_MS } });
    }
  }

  /**
   * One short transaction: the counter upsert and the receiving-state touch. The upsert is an INSERT ... SELECT guarded on the
   * configuration still being active and its project still live, so a project deleted a moment after the lookup accumulates no
   * orphan counter. A non-AI referral stores no counter but still proves the beacon is installed, so it touches the state.
   */
  private async record(
    workspaceId: string,
    configId: string,
    tokenHash: Buffer,
    event: { landing: { url: string; hash: Buffer }; referrerClass: string; isConversionEvent: boolean; conversion: { name: string; value?: number | undefined } | undefined; country: string; device: string },
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        if (event.referrerClass !== "non_ai" && (!event.isConversionEvent || event.conversion !== undefined)) {
          const upsert = await tx.query(
            `INSERT INTO attribution_daily (workspace_id, project_id, metric_date, landing_url_hash, landing_url, referrer_class,
                                            sessions, conversions, conversion_value, country, device)
             SELECT c.workspace_id, c.project_id, (now() AT TIME ZONE 'UTC')::date, $3, $4, $5, $11::int, $6, $7, $8, $9
               FROM attribution_configs c
               JOIN projects p ON p.id = c.project_id AND p.workspace_id = c.workspace_id AND p.deleted_at IS NULL
              WHERE c.id = $1 AND c.workspace_id = $2 AND c.site_token_hash = $10 AND c.status <> 'disabled'
             ON CONFLICT (project_id, metric_date, landing_url_hash, referrer_class, country, device)
             DO UPDATE SET sessions = attribution_daily.sessions + EXCLUDED.sessions,
                           conversions = attribution_daily.conversions + EXCLUDED.conversions,
                           conversion_value = attribution_daily.conversion_value + EXCLUDED.conversion_value,
                           ingested_at = now()`,
            [configId, workspaceId, event.landing.hash, event.landing.url, event.referrerClass, event.conversion === undefined ? 0 : 1, (event.conversion?.value ?? 0).toFixed(2), event.country, event.device, tokenHash, event.isConversionEvent ? 0 : 1],
          );
          if (upsert.rowCount === 0) return false;
        }
        // At most one write a minute per configuration: the indicator needs minute precision, not a hot row.
        await tx.query(
          `UPDATE attribution_configs
              SET status = 'receiving', first_event_at = COALESCE(first_event_at, now()), last_event_at = now()
            WHERE id = $1 AND workspace_id = $2 AND status <> 'disabled'
              AND (status <> 'receiving' OR first_event_at IS NULL OR last_event_at < now() - interval '1 minute')`,
          [configId, workspaceId],
        );
        return true;
      });
    } finally {
      client.release();
    }
  }
}
