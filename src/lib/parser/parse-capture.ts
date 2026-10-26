import type { ClientBase } from "pg";
import type { AnswerElement } from "../engines/contract.js";
import { aliasSetFingerprint, loadAliasSet } from "../capture/l3-short-circuit.js";
import { reusedStatusSql } from "../rollup/aggregate-day.js";
import {
  classifyAnswerForm,
  classifyPositionClass,
  type AnswerForm,
  type PositionClass,
} from "./answer-structure.js";
import { dedupeWithinResponse, extractCitations, resolveCitation, type ResolveContext, type ResolvedCitation } from "./citations.js";
import { buildMatcher, matchEntities, type AliasEntry, type Mention } from "./entity-matcher.js";
import { normalize, NORMALIZER_VERSION } from "./normalize.js";
import { classifyRendering, type RenderingResult } from "./rendering.js";
import { classifyMention, type SentimentVerdict, type StructuralContext } from "./sentiment/classify.js";
import type { SentimentArbiter } from "./sentiment/arbiter.js";
import {
  entityProminence,
  responseShareOfVoice,
  SCORING_VERSION,
  type ClauseKind,
  type MentionInput,
} from "../scoring/index.js";

// STORY-135 — the parse stage. `tracking-engine.md` Stages 1 through 6.
//
// THE GAP THIS CLOSES (`G10`). STORY-035 through 041 shipped seven parser
// libraries and a scoring library, all tested, and NOT ONE OF THEM HAD A
// CALLER. Nothing normalised a stored answer, nothing wrote `mention_facts`
// or `citation_facts`, and no capture ever left `status = 'captured'`. Every
// number in the product is computed from rows that nothing was writing.
//
// This is the one place the chain is assembled, in the order §7 lays it out:
//
//   1  normalize        every offset below is defined against its output
//   2  matchEntities    aliases, boundaries, untracked discovery
//   3  citations        extract, resolve, classify, dedupe
//   4  sentiment        per mention, band-limited arbiter
//   5  rendering        form, attributes, and the position class
//   6  score and write  prominence, share of voice, ONE TRANSACTION
//
// STAGE 6'S "SINGLE TRANSACTION WITH THE FACT ROWS" IS THE WHOLE SHAPE OF
// THIS FILE. A capture marked `parsed` whose mentions did not land, or
// mentions without the capture that owns them, is a fact set the
// application-enforced integrity reports as an orphan — and it is
// unrecoverable without a re-parse nobody knows to run. So `parseCapture`
// takes a transaction and never opens one: the caller owns the boundary, and
// the caller is the queue handler, which already has one.

export interface CaptureRow {
  readonly resultId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly promptId: string;
  readonly engineKey: string;
  readonly capturedAt: Date;
  /** The raw answer, straight from `answer_captures.payload`. */
  readonly text: string;
  readonly structuredCitations?: readonly { readonly url: string; readonly title?: string; readonly slot: number }[];
  readonly structuredElements?: readonly AnswerElement[];
  /** `answer_captures.flags` — a refusal is data and reaches the parse. */
  readonly flags: readonly string[];
}

export interface ParseContext {
  readonly rootDomain: string;
  readonly ownedDomains: readonly string[];
  readonly competitorDomains: readonly string[];
  readonly negativeAliases: readonly string[];
  readonly aliases: readonly AliasEntry[];
  /** Unbound in production — see sentiment/arbiter.ts. */
  readonly arbiter?: SentimentArbiter;
  readonly now?: () => Date;
  /**
   * How a citation URL is resolved. Absent, the guarded network fetcher (the capture worker). The request-path RE-PARSE (STORY-034
   * AC9) supplies one that answers from the resolutions already recorded, so a request handler never calls a citation's host.
   */
  readonly fetch?: NonNullable<ResolveContext["fetch"]>;
}

export interface ParsedMention {
  readonly mention: Mention;
  readonly prominence: number;
  readonly sentiment: SentimentVerdict;
  readonly rendering: RenderingResult;
  readonly positionClass: PositionClass;
}

export interface ParseResult {
  readonly normalizedText: string;
  readonly answerForm: AnswerForm;
  readonly mentions: readonly ParsedMention[];
  readonly citations: readonly ResolvedCitation[];
  readonly brandPresent: boolean;
  readonly brandRankPosition: number | null;
  readonly brandSov: number;
  readonly flags: readonly string[];
}

/** The project's own brand, as the matcher and the scorer both key it. */
export const BRAND_KEY = "brand";

function entityKeyOf(mention: Mention): string {
  return mention.entityType === "brand" ? BRAND_KEY : `${mention.entityType}:${mention.entityId ?? mention.entityLabel}`;
}

/**
 * The position class, translated into the clause the prominence formula
 * takes.
 *
 * §2.1 names three clause cases and STORY-040 classifies five position
 * classes, so the mapping is stated here rather than left to a caller: a
 * `recommendation` earns the 1.20 bonus, an `also_consider` or a `caveat` is
 * the 0.75 tail, and everything else is neutral. Deriving the clause from the
 * class rather than re-reading the text is what keeps the two from ever
 * disagreeing about the same mention.
 */
function clauseFor(positionClass: PositionClass): ClauseKind {
  if (positionClass === "recommendation") return "recommendation";
  if (positionClass === "also_consider" || positionClass === "caveat") return "tail";
  return "neutral";
}

/** §4's contrastive conjunctions, for the structural signal shared by sentiment and prominence. */
const CONTRASTIVE = /\b(however|but|although|while|though)\b/iu;

/**
 * The structural context, computed ONCE and used by both sentiment and
 * prominence.
 *
 * They ask overlapping questions of the same sentence — "is this a
 * recommendation clause", "did the answer pivot away from this mention" — and
 * computing them separately is how the two would eventually answer
 * differently about one mention.
 */
function structuralContextFor(text: string, mention: Mention, positionClass: PositionClass, nearComplaint: boolean): StructuralContext {
  const lineStart = text.lastIndexOf("\n", Math.max(0, mention.charStart - 1)) + 1;
  const lineEnd = text.indexOf("\n", mention.charEnd);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  const afterMention = text.slice(mention.charEnd, lineEnd === -1 ? text.length : lineEnd);

  return {
    listPosition: mention.listPosition,
    isRankedList: mention.listPosition !== null,
    inRecommendationClause: positionClass === "recommendation",
    // AWAY, specifically: the pivot has to come AFTER the mention to be a
    // pivot away from it. "HubSpot is great, but Salesforce scales better"
    // pivots away from HubSpot; "Salesforce is clunky, but HubSpot is easy"
    // pivots TOWARD it, and penalising both would punish a brand for winning
    // the comparison.
    contrastivePivotAway: CONTRASTIVE.test(afterMention) && line.length > afterMention.length,
    inAlsoConsiderTail: positionClass === "also_consider",
    nearComplaintCitation: nearComplaint,
  };
}

/**
 * Parse one capture, end to end. Writes nothing — the caller persists.
 *
 * Separated from `persistParse` so the whole chain is testable without a
 * database, and so the transaction stays as short as the writes: resolving a
 * citation means fetching a redirect, and holding a Postgres transaction open
 * across three seconds of network for every citation in the answer would tie
 * a connection to a vendor's latency.
 */
export async function parseCapture(capture: CaptureRow, context: ParseContext): Promise<ParseResult> {
  const text = normalize(capture.text);

  const structure = classifyAnswerForm(text, capture.structuredElements);
  const mentions = matchEntities(
    { text, aliases: context.aliases, negativeAliases: context.negativeAliases },
    buildMatcher(context.aliases),
  );

  // CITATIONS BEFORE SENTIMENT, because sentiment's `nearComplaintCitation`
  // reads them: a negative mention beside a complaint-source citation is
  // STORY-038's one deterministic negative reason, and it cannot be known
  // until the citations are classified.
  const extracted = extractCitations(text, capture.structuredCitations);
  const resolved = await Promise.all(extracted.map((citation) => resolveCitation(citation, context)));
  const citations = dedupeWithinResponse(resolved);
  const complaintSpans = complaintCitationLines(text, citations);

  const parsed: ParsedMention[] = [];
  for (const mention of mentions) {
    const position = classifyPositionClass({
      text,
      mention: { start: mention.charStart, end: mention.charEnd },
      answerForm: structure.form,
      listPosition: mention.listPosition,
      // Spread rather than passed as `undefined`: `exactOptionalPropertyTypes`
      // distinguishes an absent optional from one explicitly set to
      // undefined, and STORY-040 branches on absence to decide `derived`
      // versus `inferred`.
      ...(capture.structuredElements !== undefined ? { elements: capture.structuredElements } : {}),
      ...(elementIndexFor(capture.structuredElements, mention) !== undefined
        ? { elementIndex: elementIndexFor(capture.structuredElements, mention)! }
        : {}),
    });

    const nearComplaint = complaintSpans.some((line) => mention.charStart >= line.start && mention.charStart < line.end);
    const structural = structuralContextFor(text, mention, position.positionClass, nearComplaint);

    parsed.push({
      mention,
      // Filled in below — prominence needs every mention's span first.
      prominence: 0,
      sentiment: await classifyMention({
        text,
        mention: { start: mention.charStart, end: mention.charEnd },
        structure: structural,
        ...(context.arbiter !== undefined ? { arbiter: context.arbiter } : {}),
      }),
      rendering: classifyRendering({
        text,
        mention: { start: mention.charStart, end: mention.charEnd },
        engineKey: capture.engineKey,
        isPrimaryRecommendation: position.positionClass === "recommendation" && mention.listPosition === 1,
        ...(elementFor(capture.structuredElements, mention) !== undefined
          ? { element: elementFor(capture.structuredElements, mention)! }
          : {}),
      }),
      positionClass: position.positionClass,
    });
  }

  // §2.1 — prominence is computed over the WHOLE response at once, because
  // `frequency_score` counts an entity's occurrences and the entity-level
  // value is the maximum over its mentions. Neither is knowable one mention
  // at a time.
  const prominenceInputs: MentionInput[] = parsed.map((entry) => ({
    entityKey: entityKeyOf(entry.mention),
    charStart: entry.mention.charStart,
    listPosition: entry.mention.listPosition,
    clause: clauseFor(entry.positionClass),
    contrastivePivotAway: structuralContextFor(text, entry.mention, entry.positionClass, false).contrastivePivotAway,
    inLink: entry.mention.inLink,
  }));
  const byEntity = entityProminence({ responseLength: text.length, mentions: prominenceInputs });
  const share = responseShareOfVoice({ responseLength: text.length, mentions: prominenceInputs }, BRAND_KEY);

  const withProminence = parsed.map((entry) => ({
    ...entry,
    prominence: byEntity.get(entityKeyOf(entry.mention)) ?? 0,
  }));

  const brandMentions = withProminence.filter((entry) => entry.mention.entityType === "brand" && !entry.mention.inLink);

  return {
    normalizedText: text,
    answerForm: structure.form,
    mentions: withProminence,
    citations,
    brandPresent: brandMentions.length > 0,
    // The brand's rank in a ranked list, or null. NOT a fabricated position
    // for a brand mentioned in prose — §11's own note about rank 0 applies
    // here: a zero would sort as the best position in anything that did not
    // special-case it.
    brandRankPosition: brandMentions.map((entry) => entry.mention.listPosition).find((value) => value !== null) ?? null,
    brandSov: share.sov.get(BRAND_KEY) ?? 0,
    // The capture's own flags carry through — `engine_refused_to_answer` is
    // set by the capture stage and is one of §2.5's cases — and the share
    // computation adds its own.
    flags: [...new Set([...capture.flags, ...share.flags])],
  };
}

/** Lines carrying a community-forum or review citation — STORY-038's `complaint_thread_cited`. */
function complaintCitationLines(text: string, citations: readonly ResolvedCitation[]): { start: number; end: number }[] {
  const complaintClasses = new Set(["community_forum", "review_marketplace"]);
  return citations
    .filter((citation) => complaintClasses.has(citation.sourceClass))
    .flatMap((citation) => {
      const at = text.indexOf(citation.rawUrl);
      if (at === -1) return [];
      const start = text.lastIndexOf("\n", at) + 1;
      const end = text.indexOf("\n", at);
      return [{ start, end: end === -1 ? text.length : end }];
    });
}

/**
 * Which structured element a mention sits in.
 *
 * NULL WHEN THE ANSWER HAS NO ELEMENTS, which is every conversational engine.
 * The elements carry no offsets, so the only honest association is by
 * description text — anything cleverer would be guessing, and STORY-040
 * records `derived` versus `inferred` precisely so a guess cannot masquerade
 * as a derivation.
 */
function elementIndexFor(elements: readonly AnswerElement[] | undefined, mention: Mention): number | undefined {
  if (elements === undefined) return undefined;
  const index = elements.findIndex((element) => element.description?.includes(mention.entityLabel) === true);
  return index === -1 ? undefined : index;
}

function elementFor(elements: readonly AnswerElement[] | undefined, mention: Mention): AnswerElement | undefined {
  const index = elementIndexFor(elements, mention);
  return index === undefined ? undefined : elements?.[index];
}

/**
 * Stage 6 — write the fact rows and the capture, in ONE transaction.
 *
 * IDEMPOTENT BY DELETE-THEN-INSERT. A re-parse is a normal operation —
 * `tracking-engine.md` §8 is titled "Re-parse, not re-capture" — so this runs
 * more than once against the same capture by design. Deleting the prior facts
 * first is what makes the second run produce the same rows as the first
 * rather than double them; `ON CONFLICT` cannot do it, because a mention has
 * no natural key that survives a normaliser change moving every offset.
 *
 * NO `workspace_id` PREDICATE ANYWHERE. RLS scopes the tenant
 * (`NFR-SEC-01`); the column is supplied because it is NOT NULL and the
 * policy checks it.
 */
export async function persistParse(
  tx: ClientBase,
  capture: CaptureRow,
  result: ParseResult,
  aliasFingerprint: Buffer,
): Promise<void> {
  await tx.query("DELETE FROM mention_facts WHERE result_id = $1", [capture.resultId]);
  await tx.query("DELETE FROM citation_facts WHERE result_id = $1", [capture.resultId]);

  for (const entry of result.mentions) {
    await tx.query(
      `INSERT INTO mention_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at,
          entity_type, entity_id, entity_label, matched_alias,
          occurrence_index, char_start, char_end, first_token_index, prominence, list_position,
          sentiment_label, sentiment_score, sentiment_confidence, sentiment_method,
          evidence_start, evidence_end, negative_reasons,
          render_form, render_attrs, render_score, position_class, answer_form, scoring_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::text[],
               $24,$25::text[],$26,$27,$28,$29)`,
      [
        capture.workspaceId,
        capture.projectId,
        capture.resultId,
        capture.promptId,
        capture.engineKey,
        capture.capturedAt,
        entry.mention.entityType,
        entry.mention.entityId,
        entry.mention.entityLabel,
        entry.mention.matchedAlias,
        entry.mention.occurrenceIndex,
        entry.mention.charStart,
        entry.mention.charEnd,
        entry.mention.firstTokenIndex,
        entry.prominence,
        entry.mention.listPosition,
        entry.sentiment.label,
        // §6's per-mention score is in [−1,1]; the classifier's raw score is
        // unbounded above by the intensifier, so it is clamped HERE rather
        // than in the classifier — which would lose the magnitude the
        // confidence calibration reads.
        Math.max(-1, Math.min(1, entry.sentiment.score)),
        entry.sentiment.confidence,
        entry.sentiment.method,
        entry.sentiment.evidenceSpan.start,
        entry.sentiment.evidenceSpan.end,
        [...entry.sentiment.negativeReasons],
        entry.rendering.form,
        [...entry.rendering.attrs],
        entry.rendering.score,
        entry.positionClass,
        result.answerForm,
        SCORING_VERSION,
      ],
    );
  }

  for (const citation of result.citations) {
    await tx.query(
      `INSERT INTO citation_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at,
          slot_index, raw_url, normalized_url, url_hash, domain, path, anchor_text, title,
          is_owned, is_competitor, source_class, http_status, resolved_at, position_weight, text_fragment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        capture.workspaceId,
        capture.projectId,
        capture.resultId,
        capture.promptId,
        capture.engineKey,
        capture.capturedAt,
        citation.slotIndex,
        citation.rawUrl,
        citation.normalizedUrl,
        citation.urlHash,
        citation.domain,
        citation.path,
        citation.anchorText,
        citation.title,
        citation.isOwned,
        citation.isCompetitor,
        citation.sourceClass,
        citation.httpStatus,
        citation.resolvedAt,
        citation.positionWeight,
        citation.textFragment,
      ],
    );
  }

  const brandSentiment = result.mentions.find((entry) => entry.mention.entityType === "brand")?.sentiment;

  await tx.query(
    // `status` is moved to 'parsed' for a captured row ONLY. A REUSED row is 'skipped' and stays 'skipped': the run
    // counts it once, from `capture_runs.skipped_cells`, and `captured_cells` counts rows in captured/parsed
    // (STORY-032 AC7). The rule lives in the statement, so no caller can break it by forgetting.
    `UPDATE answer_captures
        SET status = CASE WHEN ${reusedStatusSql("status")} THEN 'skipped' ELSE 'parsed' END,
            brand_present = $2,
            brand_rank_position = $3,
            sov = $4,
            sentiment_label = $5,
            sentiment_score = $6,
            citation_count = $7,
            owned_citation_count = $8,
            flags = $9::text[],
            normalizer_version = $10,
            scoring_version = $11,
            alias_fingerprint = $12
      WHERE id = $1`,
    [
      capture.resultId,
      result.brandPresent,
      result.brandRankPosition,
      result.brandSov,
      // NULL, NOT 'absent', WHEN THE BRAND IS NOT MENTIONED. The column's
      // CHECK does allow `'absent'`, but that value means the parser looked
      // at a mention and found no sentiment in it — not that there was no
      // mention. Writing it here would make "not named" indistinguishable
      // from "named neutrally" in every query that reads the column.
      brandSentiment?.label ?? null,
      brandSentiment === undefined ? null : Math.max(-1, Math.min(1, brandSentiment.score)),
      result.citations.length,
      result.citations.filter((citation) => citation.isOwned).length,
      [...result.flags],
      NORMALIZER_VERSION,
      SCORING_VERSION,
      aliasFingerprint,
    ],
  );
}

/** The alias set as the matcher wants it, with the competitor ids `mention_facts` needs. */
export async function loadParseContext(
  tx: ClientBase,
  projectId: string,
): Promise<{ context: Omit<ParseContext, "arbiter" | "now">; aliasFingerprint: Buffer }> {
  const aliasSet = await loadAliasSet(tx, projectId);

  const project = await tx.query<{ name: string }>("SELECT name FROM projects WHERE id = $1", [projectId]);
  const brandLabel = project.rows[0]?.name ?? aliasSet.rootDomain;

  const competitors = await tx.query<{ id: string; name: string; aliases: string[]; root_domain: string | null }>(
    "SELECT id, name, aliases, root_domain FROM competitors WHERE project_id = $1 AND deleted_at IS NULL ORDER BY name",
    [projectId],
  );

  const aliases: AliasEntry[] = [
    // The brand's OWN NAME is an alias even when `brand_aliases` is empty. A
    // project created from a URL alone has none configured, and a matcher
    // built from an empty set matches nothing — which would report every
    // answer as brand-absent and be indistinguishable from a real absence.
    ...new Set([brandLabel, ...aliasSet.brandAliases]),
  ]
    .filter((alias) => alias.trim().length > 0)
    .map((alias) => ({ entityType: "brand" as const, entityId: null, label: brandLabel, alias }));

  for (const competitor of competitors.rows) {
    for (const alias of new Set([competitor.name, ...competitor.aliases])) {
      if (alias.trim().length === 0) continue;
      aliases.push({ entityType: "competitor", entityId: competitor.id, label: competitor.name, alias });
    }
  }

  return {
    context: {
      rootDomain: aliasSet.rootDomain,
      ownedDomains: aliasSet.ownedDomains,
      competitorDomains: competitors.rows.flatMap((competitor) => (competitor.root_domain === null ? [] : [competitor.root_domain])),
      negativeAliases: aliasSet.negativeAliases,
      aliases,
    },
    aliasFingerprint: aliasSetFingerprint(aliasSet),
  };
}
