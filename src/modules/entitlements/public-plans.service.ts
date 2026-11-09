import { Inject, Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Pool } from "pg";
import type { PublicPlansResponse } from "../../../contracts/entitlements/public-plans.schema.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { publicAddonsFrom, publicCreditPackFrom, publicEngineFrom, publicPlanFrom, type EngineRow, type PlanRow } from "../../lib/entitlements/public-plans.js";
import { publicCreditPackRows } from "../../lib/credits/wallet.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";

// STORY-103 (API part) - `GET /v1/public/plans`. GLOBAL data only (`plans`, `engines`: no `workspace_id`, no row-level security), read
// on the pool like `/engines/status`, so the body is identical for every caller and carries no tenant. The filter itself is
// `lib/entitlements/public-plans.ts`; this class only reads the rows and assembles the body.
//
// A read failure is NOT swallowed: an empty or partial plans list on a pricing page is a claim, so the route answers an error and
// the page build fails rather than publishing less than the truth.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("public-plans");

@Injectable()
export class PublicPlansService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async snapshot(nowMs: number = Date.now()): Promise<PublicPlansResponse> {
    return await tracer.startActiveSpan("entitlements.public_plans.snapshot", async (span) => {
      try {
        const [plans, engines, packs] = await Promise.all([
          this.pool.query<PlanRow>("SELECT key, display_name, currency, sort_order, entitlements FROM plans WHERE is_public ORDER BY sort_order, key"),
          this.pool.query<EngineRow>("SELECT key, display_name, cadence_by_plan FROM engines WHERE status <> 'disabled' ORDER BY key"),
          publicCreditPackRows(this.pool),
        ]);
        const body: PublicPlansResponse = {
          plans: plans.rows.map(publicPlanFrom),
          engines: engines.rows.map(publicEngineFrom),
          addons: { credit_packs: packs.map(publicCreditPackFrom), subscription: publicAddonsFrom(plans.rows) },
          generated_at: new Date(nowMs).toISOString(),
        };
        span.setAttribute("nominara.public_plans.plans", body.plans.length);
        span.setAttribute("nominara.public_plans.engines", body.engines.length);
        span.setAttribute("nominara.public_plans.credit_packs", body.addons.credit_packs.length);
        incrementCounter("nominara_public_plans_served_total", { outcome: "ok" });
        logger.log({ event: "public_plans.served", plans: body.plans.length, engines: body.engines.length });
        return body;
      } catch (error) {
        incrementCounter("nominara_public_plans_served_total", { outcome: "error" });
        // The error NAME only: a zod message would quote the offending jsonb, and this body is public.
        logger.error({ event: "public_plans.snapshot_failed", error: error instanceof Error ? error.name : "unknown" });
        span.recordException(error instanceof Error ? new Error(error.name) : new Error("unknown"));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
