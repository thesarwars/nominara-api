import { randomUUID, createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { resultDocumentSchema } from "../../contracts/tracking/index.js";
import { ResultDocumentService } from "../../src/modules/tracking/result-document.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { normalize } from "../../src/lib/parser/normalize.js";
import { createCaptureParseHandler } from "../../src/lib/queue/handlers/capture-parse.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { recordSuppressedCells } from "../../src/lib/capture/record-suppressed.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { testCacheRedisUrl } from "../support/test-valkey.js";
import type { Job } from "bullmq";

// STORY-034 AC7 and STORY-091's drawer — `GET /v1/results/{id}`.
//
// THE HIGHLIGHT MAP IS THE SECURITY-CRITICAL PART. STORY-091: "Engine
// responses are untrusted third-party text that will eventually contain
// markup, and a component that renders any of it — even 'just links' — is a
// cross-site scripting vector reachable by anyone who can influence what an
// engine says about a brand."
//
// The server's half of that guarantee is that it sends the verbatim text and
// a list of OFFSETS, and nothing a renderer could mistake for markup.

const ANSWER = "HubSpot is recommended. Salesforce is clunky. <script>alert(1)</script>";

describe("STORY-034 AC7 · the parser document", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let promptId: string;
  let resultId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE mention_facts, citation_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, workspaces, engines CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    resultId = randomUUID();

    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      "INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'HubSpot',$3,'https://hubspot.com','hubspot.com')",
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,$3,'best crm',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
    await seedCapture();
  });

  async function seedCapture(over: Record<string, unknown> = {}): Promise<void> {
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,
          normalizer_version,scoring_version,content_hash,payload,flags,cache_layer,status,
          brand_present,sov,sentiment_label,sentiment_score,citation_count,owned_citation_count,truncated)
       VALUES ($1,$2,$3,$4,$5,'chatgpt', now(),'api','1.0.0','n1','v1',$6,$7::jsonb,$8,$9,$10,true,0.62,'positive',0.5,1,1,false)`,
      [
        resultId,
        workspaceId,
        projectId,
        uuidV7(),
        promptId,
        createHash("sha256").update(ANSWER).digest(),
        JSON.stringify({ format: "markdown", text: (over.text as string | undefined) ?? ANSWER }),
        (over.flags as string[] | undefined) ?? [],
        (over.cacheLayer as string | undefined) ?? "live",
        (over.status as string | undefined) ?? "parsed",
      ],
    );
  }

  async function addMention(over: Record<string, unknown> = {}): Promise<void> {
    await db.query(
      `INSERT INTO mention_facts
         (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,entity_type,entity_id,
          entity_label,matched_alias,occurrence_index,char_start,char_end,first_token_index,prominence,
          sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,evidence_start,evidence_end,
          negative_reasons,render_form,render_attrs,render_score,position_class,answer_form,in_link)
       VALUES ($1,$2,$3,$4,'chatgpt', now(),$5,NULL,$6,$6,0,$7,$8,0,$9,$10,0.5,0.9,'lexicon',$11,$12,
               '{}','described','{link}',0.16,'recommendation','narrative',$13)`,
      [
        workspaceId,
        projectId,
        resultId,
        promptId,
        (over.entityType as string | undefined) ?? "brand",
        (over.label as string | undefined) ?? "HubSpot",
        (over.charStart as number | undefined) ?? 0,
        (over.charEnd as number | undefined) ?? 7,
        (over.prominence as number | undefined) ?? 0.87,
        (over.sentimentLabel as string | undefined) ?? "positive",
        (over.evidenceStart as number | undefined) ?? 0,
        (over.evidenceEnd as number | undefined) ?? 23,
        (over.inLink as boolean | undefined) ?? false,
      ],
    );
  }

  function get(id = resultId) {
    return withTenantContext(db, { workspaceId, actorId: randomUUID() }, () => new ResultDocumentService().get(id));
  }

  it("returns a document that validates against §6's schema", async () => {
    await addMention();
    const document = await get();
    expect(resultDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("returns the answer VERBATIM, markup and all", async () => {
    // The drawer's whole premise: the text is untrusted and is shown as
    // written. Sanitising it HERE would be the wrong fix — it would silently
    // alter what the engine said, and every stored offset would then index a
    // string that no longer exists.
    await addMention();
    const document = await get();
    expect(document.raw_response.text).toBe(ANSWER);
    expect(document.raw_response.text).toContain("<script>");
    expect(document.raw_response.normalized_text_offsets).toBe(true);
  });

  it("sends OFFSETS AND A CLASS, and nothing a renderer could mistake for markup", async () => {
    await addMention();
    const document = await get();

    expect(document.highlight_map).toHaveLength(1);
    expect(Object.keys(document.highlight_map[0]!).sort()).toEqual(["char_end", "char_start", "class", "entity_id"]);
    // The class is from a closed set, so a renderer maps it to one of a fixed
    // number of CSS classes and can emit nothing else.
    expect(document.highlight_map[0]!.class).toBe("brand-positive");
  });

  it("scenario 15 — DROPS a span past the end of the text rather than clamping or throwing", async () => {
    // "Rejected safely; no partial render, no exception surfaced to the
    // user." Clamping highlights the wrong characters; throwing takes the
    // whole drawer down over one bad row. The answer renders correctly with
    // one highlight missing, and a re-parse fixes the row.
    await addMention({ charStart: 0, charEnd: 7 });
    await addMention({ label: "Salesforce", charStart: 24, charEnd: 9_999 });

    const document = await get();
    expect(document.highlight_map).toHaveLength(1);
    expect(document.highlight_map[0]!.char_end).toBe(7);
    // The entity is still listed — only its highlight is dropped, so the
    // drawer can say the mention exists without mis-highlighting it.
    expect(document.entities).toHaveLength(2);
  });

  it("drops an inverted span, and one that starts before zero", async () => {
    await addMention({ charStart: 20, charEnd: 5 });
    expect((await get()).highlight_map).toEqual([]);
  });

  it("emits a NON-OVERLAPPING, sorted map so a renderer needs no nesting logic", async () => {
    // A renderer deciding which of two overlapping untrusted spans wins is
    // exactly the decision this design removes.
    await addMention({ charStart: 0, charEnd: 23 });
    await addMention({ label: "Salesforce", entityType: "competitor", charStart: 5, charEnd: 30 });

    const map = (await get()).highlight_map;
    expect(map).toHaveLength(1);
    for (let i = 1; i < map.length; i += 1) {
      expect(map[i]!.char_start).toBeGreaterThanOrEqual(map[i - 1]!.char_end);
    }
  });

  it("groups occurrences under their entity, with the evidence span on the verdict", async () => {
    // STORY-038 AC3 — there is no sentiment verdict without the sentence that
    // caused it, and the drawer renders it beside the label.
    await addMention({ charStart: 0, charEnd: 7 });
    const document = await get();

    const brand = document.entities.find((entity) => entity.entity_type === "brand")!;
    expect(brand.occurrences).toHaveLength(1);
    expect(brand.sentiment.evidence_char_start).toBe(0);
    expect(brand.sentiment.evidence_char_end).toBe(23);
    expect(ANSWER.slice(brand.sentiment.evidence_char_start!, brand.sentiment.evidence_char_end!)).toContain("recommended");
  });

  it("STORY-036 AC5 - in_link is read back from the stored row, true for a link-internal occurrence and false otherwise", async () => {
    await addMention({ charStart: 0, charEnd: 7, inLink: true });
    await addMention({ label: "Salesforce", entityType: "competitor", charStart: 20, charEnd: 30, inLink: false });
    const document = await get();
    expect(document.entities.find((entity) => entity.entity_type === "brand")!.occurrences[0]!.in_link).toBe(true);
    expect(document.entities.find((entity) => entity.entity_type === "competitor")!.occurrences[0]!.in_link).toBe(false);
  });

  it("REFUSES a failed cell rather than returning an empty document", async () => {
    // An empty `raw_response.text` with no entities renders as an answer that
    // mentioned nobody — a measurement, and the opposite of what a failed
    // cell means.
    await db.query("UPDATE answer_captures SET status = 'failed', error_code = 'engine_timeout' WHERE id = $1", [resultId]);
    await expect(get()).rejects.toMatchObject({ code: "precondition_unmet" });
  });

  // ---- STORY-091 audit: the document serves the text its offsets index -------------------------------------------------

  /** CRLF, a zero-width space inside a name, an NFD e-acute, and a run of blank lines - each one shifts every offset after it. */
  const DRIFTY = "Intro\r\n\r\n\r\n\r\nHub\u200bSpot is great.\r\nCafe\u0301 notes: HubSpot wins. Salesforce lags.\n\n\n\n\nFinally HubSpot again.";

  async function parseForReal(id: string): Promise<void> {
    const context = { pool: undefined, env: { VALKEY_CACHE_URL: testCacheRedisUrl() } } as unknown as QueueHandlerContext;
    const job = {
      data: { payload: { workspaceId, kid: "k", resultId: id, projectId, promptId, engineKey: "chatgpt", capturedAt: new Date().toISOString(), force: true } },
    } as unknown as Job;
    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => createCaptureParseHandler(context, { enqueueRollup: async () => undefined })(tx, job));
  }

  it("STORY-091 audit B1 - serves the NORMALISED text, so every highlight slices to its matched alias (CRLF, ZWSP, NFD, 3+ newlines)", async () => {
    await db.query("DELETE FROM answer_captures WHERE id = $1", [resultId]);
    await seedCapture({ text: DRIFTY, status: "captured" });
    await parseForReal(resultId);

    const document = await get();
    expect(document.raw_response.text).toBe(normalize(DRIFTY));
    expect(document.raw_response.char_count).toBe(normalize(DRIFTY).length);
    expect(document.highlight_map.length).toBeGreaterThanOrEqual(3);
    const aliases = document.entities.flatMap((entity) => entity.occurrences.map((o) => [o.char_start, entity.matched_alias] as const));
    for (const highlight of document.highlight_map) {
      const alias = aliases.find(([start]) => start === highlight.char_start)![1];
      expect(document.raw_response.text.slice(highlight.char_start, highlight.char_end).toLowerCase()).toBe(alias.toLowerCase());
    }
    for (const entity of document.entities) {
      const first = entity.occurrences[0]!;
      const { evidence_char_start: from, evidence_char_end: to } = entity.sentiment;
      expect(from).not.toBeNull();
      const evidence = document.raw_response.text.slice(from!, to!);
      expect(evidence.toLowerCase()).toContain(entity.matched_alias.toLowerCase());
      expect(from!).toBeLessThanOrEqual(first.char_start);
      expect(to!).toBeGreaterThanOrEqual(first.char_end);
    }
    expect(document.flags).not.toContain("highlights_withheld_normalizer_stale");
  });

  it("STORY-091 audit B1 - a row parsed under another normaliser version gets the normalised text, NO highlights, and a flag saying so", async () => {
    await db.query("DELETE FROM answer_captures WHERE id = $1", [resultId]);
    await seedCapture({ text: DRIFTY, status: "captured" });
    await parseForReal(resultId);
    await db.query("UPDATE answer_captures SET normalizer_version = 'n0' WHERE id = $1", [resultId]);

    const document = await get();
    expect(document.raw_response.text).toBe(normalize(DRIFTY));
    expect(document.highlight_map).toEqual([]);
    expect(document.flags).toContain("highlights_withheld_normalizer_stale");
    // Audit round 2 - every OTHER offset indexes the same stale string, so none may leave the server: occurrences are omitted (the
    // contract's char_start/char_end are non-nullable) and the evidence span is null (it is nullable). The entities themselves stay.
    expect(document.entities.length).toBeGreaterThan(0);
    for (const entity of document.entities) {
      expect(entity.occurrences).toEqual([]);
      expect(entity.sentiment.evidence_char_start).toBeNull();
      expect(entity.sentiment.evidence_char_end).toBeNull();
    }
    expect(resultDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("STORY-091 audit B3 - an L2 cell (no payload text) shows its SOURCE's text, with highlights that line up", async () => {
    await db.query("DELETE FROM answer_captures WHERE id = $1", [resultId]);
    await seedCapture({ text: DRIFTY, status: "captured" });
    await parseForReal(resultId);
    const fingerprint = (await db.query<{ alias_fingerprint: Buffer }>("SELECT alias_fingerprint FROM answer_captures WHERE id = $1", [resultId])).rows[0]!.alias_fingerprint;
    const runId = uuidV7();
    await db.query("INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, status) VALUES ($1,$2,$3,'scheduled',ARRAY['perplexity'],'completed')", [runId, workspaceId, projectId]);
    await recordSuppressedCells(
      db,
      { workspaceId, projectId, runId, normalizerVersion: "n1", captureMode: "api", aliasFingerprint: fingerprint },
      [{ layer: "l2", promptId, engineKey: "perplexity", sampleIndex: 0, sourceResultId: resultId, sourceContentHash: createHash("sha256").update(DRIFTY).digest(), adapterVersion: "1.0.0" }],
    );
    const l2 = (await db.query<{ id: string }>("SELECT id FROM answer_captures WHERE run_id = $1 AND status = 'skipped'", [runId])).rows[0]!.id;
    expect((await db.query("SELECT payload FROM answer_captures WHERE id = $1", [l2])).rows[0]!.payload).toEqual({});
    await parseForReal(l2);

    const document = await get(l2);
    expect(document.raw_response.text).toBe(normalize(DRIFTY));
    expect(document.highlight_map.length).toBeGreaterThanOrEqual(3);
    // The format comes from the SOURCE payload for an L2 row (its own payload is {}).
    await db.query("UPDATE answer_captures SET payload = jsonb_set(payload, '{format}', '\"plain\"') WHERE id = $1", [resultId]);
    expect((await get(l2)).raw_response.format).toBe("plain");
    for (const highlight of document.highlight_map) {
      expect(document.raw_response.text.slice(highlight.char_start, highlight.char_end).toLowerCase()).toMatch(/hubspot|salesforce/u);
    }
  });

  it("STORY-091 audit B3 - an L2 cell whose source is in ANOTHER project resolves to an empty answer, never that project's text", async () => {
    const otherProject = randomUUID();
    const foreign = randomUUID();
    await db.query("INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'Other',$3,'https://o.com','o.com')", [otherProject, workspaceId, `o-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO answer_captures (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,normalizer_version,scoring_version,content_hash,payload,flags,cache_layer,status,truncated)
       VALUES ($1,$2,$3,$4,$5,'chatgpt',now(),'api','1.0.0','n1','v1',$6,$7::jsonb,'{}','live','parsed',false)`,
      [foreign, workspaceId, otherProject, uuidV7(), promptId, createHash("sha256").update("x").digest(), JSON.stringify({ text: "SECRET OTHER PROJECT" })],
    );
    await db.query("UPDATE answer_captures SET payload = '{}'::jsonb, cache_layer = 'l2', source_result_id = $2, status = 'skipped' WHERE id = $1", [resultId, foreign]);
    expect((await get()).raw_response.text).toBe("");
  });

  it("404s for a result that does not exist", async () => {
    await expect(get(randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports the cache layer and whether it was a hit", async () => {
    await db.query("UPDATE answer_captures SET cache_layer = 'l2' WHERE id = $1", [resultId]);
    const document = await get();
    expect(document.cache).toMatchObject({ layer: "l2", hit: true });
  });

  it("falls back to the engine KEY when the catalog has no display name", async () => {
    // The catalog is unseeded (STORY-130). A drawer header reading nothing is
    // worse than one reading `chatgpt`.
    expect((await get()).engine.display_name).toBe("chatgpt");
  });
  it("reports brand_present as NULL on a capture the parse stage has not reached", async () => {
    // Migration 0021. The capture stage writes the row; STORY-135's parse
    // stage fills the scores afterwards. `NOT NULL DEFAULT false` used to
    // report "the brand was absent" for that whole window — a measurement
    // nobody made, and the finding `l1-exact-hash.ts` already records from a
    // second-engineer review.
    await db.query("DELETE FROM answer_captures");
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,
          normalizer_version,content_hash,payload,flags,cache_layer,status)
       VALUES ($1,$2,$3,$4,$5,'chatgpt', now(),'api','1.0.0','n1',$6,$7::jsonb,'{}','live','captured')`,
      [
        resultId,
        workspaceId,
        projectId,
        uuidV7(),
        promptId,
        createHash("sha256").update(ANSWER).digest(),
        JSON.stringify({ format: "markdown", text: ANSWER }),
      ],
    );

    const document = await get();
    expect(document.metrics.brand_present).toBeNull();
    expect(document.highlight_map).toEqual([]);
    expect(resultDocumentSchema.safeParse(document).success).toBe(true);
  });
});
