import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { buildRetentionExport } from "../../src/lib/billing/retention-export/build.js";
import { encodeRawObject } from "../../src/lib/capture/raw-object.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { createCaptureParseHandler } from "../../src/lib/queue/handlers/capture-parse.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { rollUpDay } from "../../src/lib/rollup/roll-up-day.js";
import { visibilityScore } from "../../src/lib/scoring/index.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { inflateRawSync } from "node:zlib";

// STORY-041 AC14 / FR-ANL-02 - "a score recomputed by hand from an exported cell list matches the stored value exactly to the documented
// precision". The documented precision is the column's: metric_daily.visibility_score is numeric(6,3), so three decimal places.
//
// THE WHOLE ROUND TRIP, AND NOTHING ELSE SHARED WITH THE ROLLUP. The cells are parsed by the real capture.parse handler, rolled up by the
// real rollUpDay, and exported by the real retention export (the one export that carries the underlying cells: answers.jsonl with each
// cell's status and its parsed facts, and metric_daily.csv with the stored value). The recompute below reads ONLY those two exported files
// and the scoring library's own visibilityScore; it re-derives presence, share of voice, citation share and sentiment from the cell list
// with its own arithmetic, so a defect in the rollup's aggregation cannot hide behind itself.

const DAY = "2026-03-10";
const CAPTURED_AT = `${DAY}T12:00:00.000Z`;

const ANSWERS = {
  // brand first, a tracked competitor, and an UNTRACKED list entry (two capitalised tokens in a list position)
  brandLeads: "## Best tools\n\n1. **Acme** - we recommend it for most teams.\n2. Globex - deeper reporting.\n3. Initech Systems - budget pick.",
  // the brand is absent: the engine answered and did not name it. A measurement, and it must stay in the denominator.
  brandAbsent: "## Best tools\n\n1. Globex - deeper reporting.\n2. Initech Systems - budget pick.",
  // the brand mentioned with a complaint, further down
  brandCriticised: "## Tools\n\n1. Globex - the market leader.\n2. Acme - however it has a steep learning curve and poor support.",
  // nothing detected at all: share 0, brand absent, still a measured cell
  nothing: "I could not find anything relevant.",
};

/** A reader independent of the writer, as retention-export.spec.ts uses. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const packed = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    out.set(name, inflateRawSync(zip.subarray(dataAt, dataAt + packed)));
    at += 46 + nameLen;
  }
  return out;
}

/** A CSV the export wrote (CRLF, RFC 4180 quoting). Only the unquoted shape this file's columns take is needed. */
function csvRows(csv: string): Record<string, string>[] {
  const [header, ...lines] = csv.trim().split("\r\n");
  const columns = header!.split(",");
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [columns[index]!, value])));
}

interface ExportedMention {
  entity_type: "brand" | "competitor" | "other";
  entity_id: string | null;
  entity_label: string;
  prominence: number;
  sentiment_score: number;
}
interface ExportedCitation {
  position_weight: number;
  is_owned: boolean;
  http_status: number | null;
}
interface ExportedCell {
  result_id: string;
  engine_key: string;
  status: string;
  mention_facts: ExportedMention[];
  citation_facts: ExportedCitation[];
}

/**
 * The visibility score of the BRAND, recomputed by hand from an exported cell list (single engine, so engine weights cancel).
 * Scoring-models s2 and s3, written out rather than called.
 */
function recomputeBrandScore(cells: readonly ExportedCell[]): number | null {
  // s2.5 - a failed or blocked cell is not a measurement; every other status in the list is.
  const measured = cells.filter((cell) => cell.status !== "failed" && cell.status !== "blocked");
  if (measured.length === 0) return null;

  // Presence: the share of measured cells in which the brand is named.
  const present = measured.filter((cell) => cell.mention_facts.some((m) => m.entity_type === "brand")).length;
  const presenceRate = present / measured.length;

  // Share of voice, s2.2: per cell, the brand's entity prominence over the sum of EVERY detected entity's (untracked included); an
  // entity's prominence is the maximum over its mentions. Absent cells contribute 0 and stay in the denominator.
  const sovOf = (cell: ExportedCell): number => {
    const byEntity = new Map<string, number>();
    for (const m of cell.mention_facts) {
      const key = m.entity_type === "brand" ? "brand" : `${m.entity_type}:${m.entity_id ?? m.entity_label}`;
      byEntity.set(key, Math.max(byEntity.get(key) ?? 0, m.prominence));
    }
    const total = [...byEntity.values()].reduce((sum, value) => sum + value, 0);
    return total > 0 ? (byEntity.get("brand") ?? 0) / total : 0;
  };
  const shareOfVoice = measured.reduce((sum, cell) => sum + sovOf(cell), 0) / measured.length;

  // Citation share, s4: owned position weight over all position weight, resolved citations only; null with none.
  const citations = measured.flatMap((cell) => cell.citation_facts).filter((c) => c.http_status !== null);
  const totalWeight = citations.reduce((sum, c) => sum + c.position_weight, 0);
  const ownedWeight = citations.filter((c) => c.is_owned).reduce((sum, c) => sum + c.position_weight, 0);
  const citationShare = totalWeight === 0 ? null : ownedWeight / totalWeight;

  // Sentiment, s6: prominence-weighted mean of the brand's mention scores in [-1, 1], mapped to 0..100; null with no brand mention.
  const brandMentions = measured.flatMap((cell) => cell.mention_facts).filter((m) => m.entity_type === "brand");
  const prominenceSum = brandMentions.reduce((sum, m) => sum + m.prominence, 0);
  const sentimentScore =
    prominenceSum === 0 ? null : 50 * (brandMentions.reduce((sum, m) => sum + m.prominence * m.sentiment_score, 0) / prominenceSum + 1);

  return visibilityScore({ presenceRate, shareOfVoice, citationShare, sentimentScore });
}

describe("STORY-041 AC14 - a score recomputed from an exported cell list matches the stored value", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;

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

  /** Seeds a project, parses `texts` through the real handler (plus one failed cell), rolls the day up, exports, and returns both files. */
  async function exportedRoundTrip(texts: readonly string[], opts: { citations?: boolean } = {}) {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const promptId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      "INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'Acme',$3,'https://acme.example','acme.example')",
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      "INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source) VALUES ($1,$2,$3,'Globex','globex.example',ARRAY[]::text[],'user')",
      [randomUUID(), workspaceId, projectId],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, is_priority, status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );

    const insertCapture = async (text: string, status: string, sample: number): Promise<string> => {
      const id = randomUUID();
      await db.query(
        `INSERT INTO answer_captures
           (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version,
            content_hash, response_excerpt, payload, flags, cache_layer, status, sample_index)
         VALUES ($1,$2,$3,$4,$5,'gemini',$6,'api','1.0.0','n1',$7,$8,$9::jsonb,'{}','live',$10,$11)`,
        [id, workspaceId, projectId, uuidV7(), promptId, CAPTURED_AT, createHash("sha256").update(randomUUID()).digest(), text.slice(0, 280), JSON.stringify({ format: "markdown", text }), status, sample],
      );
      return id;
    };

    const context = { pool: undefined, env: {} } as unknown as QueueHandlerContext;
    const handler = createCaptureParseHandler(context, { markRollupDirty: async () => undefined, enqueueRollup: async () => undefined });
    const objects = new Map<string, Buffer>();
    const parsed: string[] = [];
    for (const [index, text] of texts.entries()) {
      const id = await insertCapture(text, "captured", index);
      const job = { data: { payload: { workspaceId, kid: "k", resultId: id, projectId, promptId, engineKey: "gemini", capturedAt: CAPTURED_AT, force: false } } } as unknown as Job;
      await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => handler(tx, job));
      parsed.push(id);
    }
    // A FAILED cell: "we could not ask". It is no measurement, so it is in neither the stored value nor (it has no raw object) the export.
    await insertCapture("", "failed", texts.length);

    if (opts.citations === true) {
      // One owned (1.0), one foreign (0.5) and one UNRESOLVED (0.7, no http status) citation on the first cell: the unresolved one is in neither half of the share.
      const rows: [string, boolean, number, number | null][] = [
        ["https://acme.example/a", true, 1.0, 200],
        ["https://other.example/b", false, 0.5, 200],
        ["https://pending.example/c", false, 0.7, null],
      ];
      for (const [slot, [url, owned, weight, status]] of rows.entries()) {
        await db.query(
          `INSERT INTO citation_facts (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url, url_hash, domain,
                                       is_owned, position_weight, http_status)
           VALUES ($1,$2,$3,$4,'gemini',$5,$6,$7,$7,$8,$9,$10,$11,$12)`,
          [workspaceId, projectId, parsed[0], promptId, CAPTURED_AT, slot, url, createHash("sha256").update(url).digest(), new URL(url).hostname, owned, weight, status],
        );
      }
    }

    // The parse wrote the facts and the status; the rollup reads them.
    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => rollUpDay(tx, workspaceId, projectId, DAY, "UTC"));

    // Give every parsed cell a raw object (as capture.execute does) so the export carries it.
    for (const id of parsed) {
      const key = `raw/${id}.json.gz`;
      await db.query("UPDATE answer_captures SET raw_object_key = $2 WHERE id = $1", [id, key]);
      objects.set(key, encodeRawObject({ format: "markdown", text: "stored answer" }));
    }

    const cutoff = new Date("2026-04-01T00:00:00Z");
    const built = await buildRetentionExport({
      workspaceId,
      scope: { purgeNotBefore: cutoff, raw: { windowDays: 10, cutoff }, rollups: { windowDays: 10, cutoff } },
      projects: [{ projectId, name: "Acme" }],
      step: (fn) => withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => fn(tx)),
      lockProject: (_id, fn) => fn(),
      readRaw: async (key) => objects.get(key)!,
      now: new Date("2026-04-02T00:00:00Z"),
    });
    const files = unzip(built.zip);
    const answers = [...files.entries()].find(([name]) => name.endsWith("answers.jsonl"))![1].toString().trim().split("\n").map((l) => JSON.parse(l) as ExportedCell);
    const metrics = csvRows([...files.entries()].find(([name]) => name.endsWith("metric_daily.csv"))![1].toString());
    return { answers, metrics };
  }

  const storedBrandScore = (metrics: Record<string, string>[], engine: string): number => {
    const row = metrics.find((r) => r.engine_key === engine && r.entity_type === "brand");
    expect(row, `a stored ${engine} brand row`).toBeDefined();
    return Number(row!.visibility_score);
  };
  /**
   * numeric(6,3) rounds to the third decimal, so a recompute agrees when it is within half a unit of the last place (0.0005). The extra 1e-4
   * is the inputs' own noise, not slack in the score: sov, prominence and sentiment are stored as float4 and exported as their shortest
   * decimal form, which differs from the float4 the rollup summed by about 1e-7 relative, i.e. under 1e-4 on a 0..100 scale. A real
   * discrepancy (a dropped cell moves the score by whole percentage points) is orders of magnitude above it.
   */
  const HALF_ULP = 0.0005 + 1e-4;

  it("STORY-041 AC14 - four cells (present, absent, criticised, nothing) and a failed one: the recompute matches the stored value to numeric(6,3)", async () => {
    const { answers, metrics } = await exportedRoundTrip([ANSWERS.brandLeads, ANSWERS.brandAbsent, ANSWERS.brandCriticised, ANSWERS.nothing]);

    expect(answers, "the failed cell is not in the cell list").toHaveLength(4);
    const recomputed = recomputeBrandScore(answers);
    expect(recomputed).not.toBeNull();
    // Guard against a vacuous pass: this dataset must exercise a score strictly between 0 and 100.
    expect(recomputed!).toBeGreaterThan(0);
    expect(recomputed!).toBeLessThan(100);
    expect(Math.abs(recomputed! - storedBrandScore(metrics, "gemini"))).toBeLessThanOrEqual(HALF_ULP);
  }, 120_000);

  it("STORY-041 AC14 - with citations (one owned, one foreign, one UNRESOLVED) the recompute still matches, and the cross-engine row equals it", async () => {
    const { answers, metrics } = await exportedRoundTrip([ANSWERS.brandLeads, ANSWERS.brandAbsent, ANSWERS.brandCriticised], { citations: true });

    const recomputed = recomputeBrandScore(answers)!;
    expect(Math.abs(recomputed - storedBrandScore(metrics, "gemini"))).toBeLessThanOrEqual(HALF_ULP);
    // One engine: the blended row is that engine's score.
    expect(Math.abs(recomputed - storedBrandScore(metrics, "all"))).toBeLessThanOrEqual(HALF_ULP);
  }, 120_000);

  it("STORY-041 AC14 - the check can FAIL: a recompute from a cell list with a cell removed does not match the stored value", async () => {
    const { answers, metrics } = await exportedRoundTrip([ANSWERS.brandLeads, ANSWERS.brandAbsent, ANSWERS.brandCriticised, ANSWERS.nothing]);
    const tampered = answers.filter((cell) => cell.mention_facts.some((m) => m.entity_type === "brand"));
    expect(Math.abs(recomputeBrandScore(tampered)! - storedBrandScore(metrics, "gemini"))).toBeGreaterThan(HALF_ULP);
  }, 120_000);
});
