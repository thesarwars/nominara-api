import { Inject, Injectable, Logger } from "@nestjs/common";
import { UNRESOLVED_INTENT } from "../../../contracts/command/command-intent.schema.js";
import {
  commandGrammarParseSchema,
  type CommandGrammarParse,
  type CommandParseResponse,
} from "../../../contracts/command/parse-response.schema.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { disabledReasonFor } from "../../lib/command/execute-access.js";
import {
  storeParseRecord,
  type ParseRecord,
} from "../../lib/command/parse-record.js";
import { planGateReason, structuralKeyFor } from "../../lib/command/plan-gate.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import type { CommandCaller } from "./command-caller.js";
import { ACTIONS, freeTextSlots, matchGrammar, normalizeQuery, SUGGESTIONS } from "./command-grammar.js";
import { PARSE_CACHE_TTL_MS, PARSE_INDEX_VERSION, parseCacheKey } from "./command-parse-cache.js";
import { EntityIndexService } from "./entity-index.service.js";

// STORY-085-A / STORY-085 - POST /v1/command/parse.
//
// THE DEPENDENCY LIST IS STILL THE SAFETY PROPERTY OF THE PARSE. `parse` reaches three things: the cache (the
// grammar result, and the single-use parse record), the entity index (SELECTs only, in the request's own
// tenant transaction) and the entitlement resolver (a read of the plan's price). It never touches a ledger, a
// queue or a write path, so "a parse never mutates and never enqueues external work" (FR-NL-04) is a fact
// about what `parse` calls. The two services `execute` needs - the run lifecycle and the tasks service - are
// called ONLY from `execute`, and test #11 (command-parse-http.spec.ts) proves across every intent that a
// parse changes no table's content except its one audit row.
//
// THE ORDER INSIDE `parse` IS THE TENANCY ARGUMENT: grammar (cached per workspace) -> THEN bind entities,
// disabled reasons and the price under THIS caller's role and project scope. Binding before the cache would
// store one caller's visible projects for the next caller of the same workspace.

/** The cached part of an answer: everything except the per-request identifiers. */
type ParseBody = CommandGrammarParse;

@Injectable()
export class CommandService {
  private readonly logger = new Logger(CommandService.name);

  constructor(
    @Inject(CACHE) private readonly cache: Cache,
    private readonly entities: EntityIndexService,
    private readonly resolver: EntitlementResolver,
  ) {}

  async parse(caller: CommandCaller, query: string): Promise<CommandParseResponse> {
    const { workspaceId } = caller;
    const normalized = normalizeQuery(query);
    const key = parseCacheKey(cacheKeyNamespace(), workspaceId, normalized, PARSE_INDEX_VERSION);

    // 1. The grammar result: identical for every caller of the workspace, so it is the only thing cached.
    const hit = await this.readCached(key);
    const body = hit ?? this.resolve(normalized);
    if (hit === null) await this.cache.set(key, JSON.stringify(body), { ttlMs: PARSE_CACHE_TTL_MS });

    // 2. Everything that depends on WHO is asking, AFTER the cache read.
    const parseId = uuidV7();
    const response = await this.personalise(caller, parseId, body, hit !== null, query);

    const outcome = body.candidates.length > 0 ? "ambiguous" : body.intent === UNRESOLVED_INTENT ? "unresolved" : "resolved";
    incrementCounter("nominara_command_parse_total", { outcome, cached: String(hit !== null) });
    // The workspace ID, never the query: the text is customer input.
    this.logger.log({ event: "command.parse", workspace_id: workspaceId, outcome, cached: hit !== null });

    return response;
  }

  /** Binds entities, disabled reasons and the price for THIS caller, and stores the single-use record the execute consumes. */
  private async personalise(
    caller: CommandCaller,
    parseId: string,
    cachedBody: ParseBody,
    cached: boolean,
    query: string,
  ): Promise<CommandParseResponse> {
    // The cache holds the NORMALISED slots (every caller of the workspace shares the entry); the free-text ones are re-read from THIS caller's own
    // words, so a task title or project name is stored and prefilled exactly as typed.
    const body: ParseBody = cachedBody.intent === UNRESOLVED_INTENT ? cachedBody : { ...cachedBody, slots: { ...cachedBody.slots, ...freeTextSlots(cachedBody.intent, query) } };
    const action = body.actions[0];
    if (action === undefined || body.intent === UNRESOLVED_INTENT) {
      // No action was offered (unresolved or ambiguous): nothing to bind, price or consume, so no record is stored.
      return { ...body, actions: [], parse_id: parseId, entities: [], cached };
    }

    const projectText = body.slots["project"];
    const bound = projectText === undefined ? null : await this.entities.bindProject(caller, projectText);
    const entities = bound === null ? [] : [{ slot: "project", kind: "project" as const, id: bound.id, name: bound.name }];

    const creditAction = body.intent === "run_deep_scan" ? ("deep_scan" as const) : null;
    const resolved = await this.resolver.resolveForWorkspace(caller.workspaceId);
    const credits = creditAction === null ? null : priceIn(resolved.entitlements, creditAction);
    // The plan gate for the other intents (one table: plan-gate.ts). The count is read only for a structural limit, and only once the role allows it.
    const roleReason = disabledReasonFor(action.required_permission, caller.membership);
    const structuralKey = roleReason === null ? structuralKeyFor(action.kind) : null;
    const used = structuralKey === null ? 0 : await this.entities.usageOf(caller, structuralKey);

    // Forbidden first (the role), then the plan: a plan that sells no price for the action is `feature_not_in_plan`
    // (FR-CMD-05), the same refusal the underlying route raises (`deepScanPriceOrThrow`).
    const disabledReason =
      roleReason ??
      (creditAction !== null && credits === null ? `feature_not_in_plan:${creditAction}.credits` : null) ??
      planGateReason(action.kind, resolved.entitlements, used);
    const personal = { ...action, disabled_reason: disabledReason, credit_estimate: credits === null ? null : { credits } };

    const record: ParseRecord = {
      workspace_id: caller.workspaceId,
      actor_id: caller.actorId,
      action_id: action.action_id,
      intent: action.kind,
      handling: action.handling,
      required_permission: action.required_permission,
      credit_action: creditAction,
      project_id: bound?.id ?? null,
      project_name: bound?.name ?? null,
      slots: body.slots,
    };
    // Stored even when the action is disabled for this caller: presenting it at execute must answer 403 naming the
    // permission (FR-CMD-05, never a vague 409), and the execute re-checks the live role either way.
    await storeParseRecord(this.cache, cacheKeyNamespace(), parseId, record);

    return { ...body, actions: [personal], parse_id: parseId, entities, cached };
  }

  private async readCached(key: string): Promise<ParseBody | null> {
    const raw = await this.cache.get(key);
    if (raw === undefined) return null;
    try {
      return commandGrammarParseSchema.parse(JSON.parse(raw));
    } catch {
      // An entry that no longer parses (an older grammar's shape) is a miss:
      // recomputing is free and deterministic. Logged, not silent.
      this.logger.warn({ event: "command.parse_cache_unreadable" });
      return null;
    }
  }

  private resolve(normalized: string): ParseBody {
    const matches = matchGrammar(normalized);
    const top = matches[0];
    const tied = top === undefined ? [] : matches.filter((m) => m.confidence === top.confidence);

    if (top !== undefined && tied.length === 1) {
      const action = ACTIONS[top.intent];
      return {
        resolved_by: "grammar",
        intent: top.intent,
        confidence: top.confidence,
        slots: top.slots,
        candidates: [],
        suggestions: [],
        actions: [
          {
            action_id: `${top.intent}`,
            kind: top.intent,
            label: action.label,
            is_mutating: action.isMutating,
            requires_confirmation: action.isMutating,
            required_permission: action.requiredPermission,
            handling: action.handling,
          },
        ],
        cost: { credits: 0 },
      };
    }

    // Ambiguous (several intents tie) or unresolved (none match): no action is
    // offered either way — a guess here could be a spending action.
    return {
      resolved_by: null,
      intent: UNRESOLVED_INTENT,
      confidence: 0,
      slots: {},
      candidates: tied.map(({ intent, confidence, slots }) => ({ intent, confidence, slots })),
      suggestions: [...SUGGESTIONS],
      actions: [],
      cost: { credits: 0 },
    };
  }
}


/** The plan's exact figure for an action, the same entitlement the credit guard confirms against; null when the plan prices none. */
function priceIn(entitlements: Readonly<Record<string, { readonly value: unknown }>>, action: "deep_scan"): number | null {
  const value = entitlements[`${action}.credits`]?.value ?? null;
  return typeof value === "number" ? value : null;
}
