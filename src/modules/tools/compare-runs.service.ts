import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Injectable, Logger } from "@nestjs/common";
import {
  auxAuditToolResultSchema,
  COMPARABLE_TOOL_KEYS,
  COMPARE_RUNS_STATEMENT,
  visibilityScanResultSchema,
  type CompareRunsRequest,
  type CompareRunsResponse,
  type CompareRunsStoredResult,
  type ToolRunDetail,
} from "../../../contracts/tools/index.js";
import { PreconditionUnmetError } from "../../api/errors/domain-errors.js";
import { diffAuditResults, diffScanResults } from "../../lib/tools/compare-runs.js";
import { toolPresentation } from "../../lib/tools/presentation.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { ToolsService } from "./tools.service.js";

// STORY-084 - Compare Runs (FR-TL-05; POST by owner decision 79).
//
// THERE IS NO CODE PATH FROM HERE TO A CAPTURE, A QUEUE JOB OR AN OUTBOUND REQUEST. This service imports ToolsService (the one owner of tool_runs)
// and the pure diff rules, and nothing else that does I/O: no queue producer, no engine, no URL guard, no storage, no wallet. That absence is what
// lets the tool be free; compare-runs.spec.ts asserts it on the imports, and the integration spec asserts it with instrumentation during a live comparison.
//
// It stores only the two run ids (`diff_base_run_id`, `diff_compare_run_id`): never a copy of either payload. Retention nulls a source's result_json, so
// a source that has expired makes the pair uncomparable, with a refusal that names the side and the time.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("tools");

type Side = "base" | "compare";
const REFUSAL_METRIC = "nominara_tools_compare_runs_refused_total";

@Injectable()
export class CompareRunsService {
  constructor(private readonly tools: ToolsService) {}

  async compare(request: CompareRunsRequest): Promise<CompareRunsResponse> {
    return await tracer.startActiveSpan("tools.compare_runs", async (span) => {
      try {
        const store = currentTenantStore();
        if (store === undefined) throw new Error("CompareRunsService requires an active tenant context");
        span.setAttribute("nominara.workspace_id", store.context.workspaceId);

        const pair = await this.tools.comparisonPair(request.base_run_id, request.compare_run_id);
        const refuse = (reason: string, message: string): never => {
          incrementCounter(REFUSAL_METRIC, { reason });
          span.setAttribute("nominara.compare_runs.refusal", reason);
          logger.log({ event: "tools.compare_runs.refused", workspace_id: store.context.workspaceId, reason });
          throw new PreconditionUnmetError({ message });
        };
        const { base, compare } = pair;

        if (base.id === compare.id) refuse("same_run", "same_run: a comparison needs two different runs; base_run_id and compare_run_id are the same run");
        if (base.tool_key !== compare.tool_key) {
          refuse("tool_mismatch", `tool_mismatch: the base run is a ${base.tool_key} and the compare run is a ${compare.tool_key}; only two runs of the same tool can be compared`);
        }
        const tool = COMPARABLE_TOOL_KEYS.find((k) => k === base.tool_key);
        if (tool === undefined) {
          refuse("tool_not_comparable", `tool_not_comparable: ${base.tool_key} runs cannot be compared; Compare Runs supports ${COMPARABLE_TOOL_KEYS.join(" and ")}`);
        }
        this.refuseExpiredOrUnfinished(base, compare, refuse);
        if (!pair.sameInput) {
          refuse("input_mismatch", `input_mismatch: the two ${base.tool_key} runs were made with different inputs (${this.differingInputs(base, compare)}); only runs with the same normalised input can be compared`);
        }

        let response: CompareRunsResponse;
        if (tool === "visibility_scan") {
          const baseResult = visibilityScanResultSchema.safeParse(base.result);
          const compareResult = visibilityScanResultSchema.safeParse(compare.result);
          if (!baseResult.success) refuse("result_unreadable", "result_unreadable: the base run's stored result cannot be read as a scan");
          if (!compareResult.success) refuse("result_unreadable", "result_unreadable: the compare run's stored result cannot be read as a scan");
          response = await this.finish("visibility_scan", base, compare, { scan: diffScanResults(baseResult.data!, compareResult.data!), audit: null });
        } else {
          const baseResult = auxAuditToolResultSchema.safeParse(base.result);
          const compareResult = auxAuditToolResultSchema.safeParse(compare.result);
          if (!baseResult.success) refuse("result_unreadable", "result_unreadable: the base run's stored result cannot be read as an audit");
          if (!compareResult.success) refuse("result_unreadable", "result_unreadable: the compare run's stored result cannot be read as an audit");
          const baseAudit = baseResult.data!.audit;
          const compareAudit = compareResult.data!.audit;
          if (baseAudit === null) refuse("audit_not_full", "audit_not_full: the base run is a site-files check with no scored audit to compare");
          if (compareAudit === null) refuse("audit_not_full", "audit_not_full: the compare run is a site-files check with no scored audit to compare");
          response = await this.finish("aux_audit", base, compare, {
            scan: null,
            audit: diffAuditResults(
              { score: baseAudit!.score.value, findings_omitted: baseAudit!.findings_omitted, findings: baseAudit!.findings },
              { score: compareAudit!.score.value, findings_omitted: compareAudit!.findings_omitted, findings: compareAudit!.findings },
            ),
          });
        }
        span.setAttribute("nominara.compare_runs.reopened", response.reopened);
        incrementCounter("nominara_tools_compare_runs_total", { compared_tool: response.compared_tool, reopened: String(response.reopened) });
        logger.log({ event: "tools.compare_runs.compared", workspace_id: store.context.workspaceId, comparison_id: response.id, compared_tool: response.compared_tool, reopened: response.reopened });
        return response;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /** AC7 - an expired run's payload is gone by design: name the side and when. A run still `running` or `failed` has nothing to compare either. */
  private refuseExpiredOrUnfinished(base: ToolRunDetail, compare: ToolRunDetail, refuse: (reason: string, message: string) => never): void {
    const now = Date.now();
    const sides: [Side, ToolRunDetail][] = [["base", base], ["compare", compare]];
    const expired = sides.filter(([, run]) => run.status === "expired" || Date.parse(run.expires_at) <= now);
    if (expired.length > 0) {
      const named = expired.map(([side, run]) => `the ${side} run (${run.id}) expired at ${run.expires_at}`).join("; ");
      refuse("run_expired", `run_expired: ${named}; its stored result was removed by retention and an expired run cannot be compared`);
    }
    for (const [side, run] of sides) {
      if (run.status !== "completed" && run.status !== "partial") {
        refuse("run_not_comparable", `run_not_comparable: the ${side} run (${run.id}) is ${run.status}; only completed or partial runs can be compared`);
      }
    }
  }

  private differingInputs(base: ToolRunDetail, compare: ToolRunDetail): string {
    const keys = (Object.keys(base.inputs) as (keyof ToolRunDetail["inputs"])[]).filter((k) => JSON.stringify(base.inputs[k]) !== JSON.stringify(compare.inputs[k]));
    return keys.length === 0 ? "differences are in normalisation only" : `${keys.join(", ")} differ`;
  }

  /** Re-open the stored comparison of this ordered pair, or store one (two ids, no payload) on the shared timeline. Free either way. */
  private async finish(
    comparedTool: CompareRunsStoredResult["compared_tool"],
    base: ToolRunDetail,
    compare: ToolRunDetail,
    body: Pick<CompareRunsResponse, "scan" | "audit">,
  ): Promise<CompareRunsResponse> {
    let id = await this.tools.findComparison(base.id, compare.id);
    const reopened = id !== null;
    if (id === null) {
      const stored: CompareRunsStoredResult = { schema_version: 1, compared_tool: comparedTool, base_run_id: base.id, compare_run_id: compare.id };
      const started = await this.tools.startRun({ toolKey: "compare_runs", engineKeys: [], diffBaseRunId: base.id, diffCompareRunId: compare.id, resultJson: stored, credits: 0 });
      await this.tools.finishRun(started.id, { enginesSucceeded: [], enginesFailed: [] });
      id = started.id;
    }
    const presentation = toolPresentation("compare_runs", {
      sov_estimate: null, citation_count: null, sentiment_label: null, brand_present: null, aux_score: null, entities_found: null, pages_scanned: null, items_kept: null,
    });
    const ref = (run: ToolRunDetail) => ({ id: run.id, created_at: run.created_at, expires_at: run.expires_at });
    return {
      id,
      tool_key: "compare_runs",
      compared_tool: comparedTool,
      base: ref(base),
      compare: ref(compare),
      scan: body.scan,
      audit: body.audit,
      credits_charged: 0,
      reopened,
      not_tracked: true,
      not_tracked_note: presentation.not_tracked_note,
      did_not_check: presentation.did_not_check,
      statement: COMPARE_RUNS_STATEMENT,
    };
  }
}
