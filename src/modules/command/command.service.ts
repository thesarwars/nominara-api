import { Inject, Injectable, Logger } from "@nestjs/common";
import { UNRESOLVED_INTENT } from "../../../contracts/command/command-intent.schema.js";
import {
  commandParseResponseSchema,
  type CommandParseResponse,
} from "../../../contracts/command/parse-response.schema.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { ACTIONS, matchGrammar, normalizeQuery, SUGGESTIONS } from "./command-grammar.js";
import { PARSE_CACHE_TTL_MS, PARSE_INDEX_VERSION, parseCacheKey } from "./command-parse-cache.js";

// STORY-085-A — POST /v1/command/parse, grammar and cache only.
//
// THE DEPENDENCY LIST IS THE SAFETY PROPERTY. This service takes the cache
// and nothing else — no database, no queue, no credit or billing service — so
// "a parse never mutates and never enqueues external work" (FR-NL-04) is a
// fact about what the class can reach, not a branch someone could get wrong.
// It also never debits: cost is the literal 0, and the 1-credit model parse is
// a later slice that must add its own collaborators visibly.

/** The cached part of an answer: everything except the per-request identifiers. */
type ParseBody = Omit<CommandParseResponse, "parse_id" | "cached">;

@Injectable()
export class CommandService {
  private readonly logger = new Logger(CommandService.name);

  constructor(@Inject(CACHE) private readonly cache: Cache) {}

  async parse(workspaceId: string, query: string): Promise<CommandParseResponse> {
    const normalized = normalizeQuery(query);
    const key = parseCacheKey(cacheKeyNamespace(), workspaceId, normalized, PARSE_INDEX_VERSION);

    const hit = await this.readCached(key);
    const body = hit ?? this.resolve(normalized);
    if (hit === null) await this.cache.set(key, JSON.stringify(body), { ttlMs: PARSE_CACHE_TTL_MS });

    const outcome = body.candidates.length > 0 ? "ambiguous" : body.intent === UNRESOLVED_INTENT ? "unresolved" : "resolved";
    incrementCounter("nominara_command_parse_total", { outcome, cached: String(hit !== null) });
    // The workspace ID, never the query: the text is customer input.
    this.logger.log({ event: "command.parse", workspace_id: workspaceId, outcome, cached: hit !== null });

    return { parse_id: uuidV7(), ...body, cached: hit !== null };
  }

  private async readCached(key: string): Promise<ParseBody | null> {
    const raw = await this.cache.get(key);
    if (raw === undefined) return null;
    try {
      const { parse_id: _id, cached: _cached, ...body } = commandParseResponseSchema.parse({
        parse_id: uuidV7(),
        cached: false,
        ...(JSON.parse(raw) as object),
      });
      return body;
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
