import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Injectable, Logger } from "@nestjs/common";
import {
  SCHEMA_BUILDER_STATEMENT,
  type SchemaBuilderRequest,
  type SchemaBuilderResponse,
  type SchemaBuilderStoredResult,
} from "../../../contracts/tools/index.js";
import { toolPresentation } from "../../lib/tools/presentation.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { ToolsService } from "./tools.service.js";

// STORY-083 (owner decision 78a) - Schema Builder SAVE: POST /v1/tools/schema-builder.
//
// BUILD AND CHECK RUN IN THE BROWSER; THIS IS THE EXPLICIT SAVE, AND IT RECEIVES FINDINGS ONLY. The request schema has no field that can hold pasted markup, so
// nothing here ever sees it. There is no path from here to a model, an engine, a queue, a wallet or the network: this service imports ToolsService (the one owner of
// tool_runs) and reads one global catalog table, and schema-builder.spec.ts asserts the imports. The run is free (`credits: 0`; the database refuses a debit on the row).
//
// THE CONSEQUENCE IS THE CATALOG'S, NOT THE CLIENT'S. Each finding's `rationale` (customer language, the same text the project findings list leads with) is read
// from `aux_rule_catalog` and stored with the finding, so a re-opened run still leads with the rendering consequence and a client cannot put text of its own in it.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("tools.schema-builder");

@Injectable()
export class SchemaBuilderService {
  constructor(private readonly tools: ToolsService) {}

  async save(request: SchemaBuilderRequest): Promise<SchemaBuilderResponse> {
    return await tracer.startActiveSpan("tools.schema_builder.save", async (span) => {
      try {
        const store = currentTenantStore();
        if (store === undefined) throw new Error("SchemaBuilderService requires an active tenant context");
        const workspaceId = store.context.workspaceId;
        span.setAttributes({ "nominara.workspace_id": workspaceId, "nominara.schema_builder.mode": request.mode, "nominara.schema_builder.findings": request.findings.length });

        // A global, versioned catalog: no tenant column, so no workspace filter applies. A rule it does not hold fails the save closed (never a made-up consequence).
        const codes = [...new Set(request.findings.map((f) => f.rule_code))];
        const rows = codes.length === 0
          ? []
          : (await store.client.query<{ code: string; title: string; rationale: string }>("SELECT code, title, rationale FROM aux_rule_catalog WHERE code = ANY($1::text[]) AND category = 'structured_data'", [codes])).rows;
        const catalog = new Map(rows.map((r) => [r.code, r]));

        const findings = request.findings.map((f) => {
          const row = catalog.get(f.rule_code);
          if (row === undefined) throw new Error(`the rule catalog has no structured_data row for ${f.rule_code}`);
          // The key order is the order a reader meets the fields: consequence first, the rule code a reference.
          return { consequence: row.rationale, title: row.title, rule_code: f.rule_code, severity: f.severity, position: f.position, field: f.field };
        });
        const stored: SchemaBuilderStoredResult = { schema_version: 1, mode: request.mode, entity_type: request.entity_type, vocab_version: request.vocab_version, findings };

        const started = await this.tools.startRun({ toolKey: "schema_builder", engineKeys: [], resultJson: stored, credits: 0 });
        await this.tools.finishRun(started.id, { enginesSucceeded: [], enginesFailed: [] });

        const presentation = toolPresentation("schema_builder", {
          sov_estimate: null, citation_count: null, sentiment_label: null, brand_present: null, aux_score: null, entities_found: null, pages_scanned: null, items_kept: null,
        });
        incrementCounter("nominara_tools_schema_builder_saved_total", { mode: request.mode });
        for (const f of findings) incrementCounter("nominara_tools_schema_builder_findings_saved_total", { severity: f.severity });
        // Ids and counts only: never a finding's text, a field path or anything the browser pasted.
        logger.log({ event: "tools.schema_builder.saved", workspace_id: workspaceId, run_id: started.id, mode: request.mode, findings: findings.length });
        const response: SchemaBuilderResponse = {
          id: started.id,
          tool_key: "schema_builder",
          mode: request.mode,
          entity_type: request.entity_type,
          vocab_version: request.vocab_version,
          findings,
          credits_charged: 0,
          not_tracked: true,
          not_tracked_note: presentation.not_tracked_note,
          did_not_check: presentation.did_not_check,
          statement: SCHEMA_BUILDER_STATEMENT,
        };
        return response;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
