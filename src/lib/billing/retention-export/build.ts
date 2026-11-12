import type { ClientBase } from "pg";
import type { RetentionExportCoverage } from "../../../../contracts/billing/retention-export.schema.js";
import { decodeRawObject, RawObjectCorruptError } from "../../capture/raw-object.js";
import { csvCell } from "../../reports/export-csv.js";
import type { TenantStep } from "../../queue/worker-factory.js";
import type { ExportScope } from "./scope.js";
import { createZip, type ZipEntry } from "./zip.js";

// STORY-185 - the build of the full-data export: the three kinds of data the pending purge removes, per project, into one zip.
//
//   <folder>/answers.jsonl          one JSON object per raw capture older than the new raw window that still has a raw object: the answer text as
//                                   stored (`raw`, the object's own body), the capture's identifying fields, and its parsed `mention_facts` and
//                                   `citation_facts` (hashes and the workspace/project ids left out: the folder names the project)
//   <folder>/metric_daily.csv       rollup rows (a row per day, engine and entity) older than the new rollup window
//   <folder>/attribution_daily.csv  attribution rows older than the new rollup window
//   manifest.json                   the coverage, as returned by the API
//
// The predicates are the notice's own (retention-shortening.ts `rawPurgeList` / `rollupPurgeList` / `attributionPurgeList`), so a count here is the
// count there for the same data: a capture older than the raw cutoff with a raw object; a rollup or attribution DAY older than the rollup cutoff.
//
// NO TRANSACTION IS HELD ACROSS AN AWAIT ON THE OBJECT STORE (ADR-0003). Every database read is a short tenant transaction through `step`, one
// page at a time (keyset, so a page is a bounded read); every raw object is read from the store between pages with no transaction open. The
// project's purge lock (EC-40, `withExportLock`) is held around that project's reads and nothing else, by `lockProject`: the lock lives on a
// dedicated connection that is idle (never `idle in transaction`) while an object is being fetched.
//
// A raw object that cannot be read (absent, or not a raw answer body) is COUNTED in `unreadable` and `complete` goes false: never silently dropped,
// never an empty answer. Any other failure (a tenancy refusal, the store down) is thrown: the job retries, it does not ship a partial file.

export const CAPTURE_PAGE_SIZE = 200;
const ROLLUP_PAGE_SIZE = 2000;

export interface BuildProject {
  readonly projectId: string;
  /** The notice's label for the project (a soft-deleted one is marked). */
  readonly name: string;
}

export interface BuildDeps {
  readonly workspaceId: string;
  readonly scope: ExportScope;
  readonly projects: readonly BuildProject[];
  /** Each call is its own short tenant transaction. */
  readonly step: TenantStep;
  /** Holds the project's export lock (`withExportLock`) around `fn`. */
  readonly lockProject: <T>(projectId: string, fn: () => Promise<T>) => Promise<T>;
  /** Reads the object a capture's `raw_object_key` names. */
  readonly readRaw: (storedKey: string) => Promise<Buffer>;
  readonly now: Date;
}

export interface BuiltExport {
  readonly zip: Buffer;
  readonly coverage: RetentionExportCoverage;
}

/** A folder name that is safe in a zip and readable: the project's name, then the first eight characters of its id (two projects may share a name). */
export function projectFolder(name: string, projectId: string): string {
  const slug = name.replace(/ \(deleted project\)$/, "").normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${slug === "" ? "project" : slug}-${projectId.slice(0, 8)}`;
}

function field(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return csvCell(String(value));
}

class CsvFile {
  private readonly lines: string[];
  constructor(header: readonly string[]) {
    this.lines = [header.join(",")];
  }
  add(values: readonly unknown[]): void {
    this.lines.push(values.map(field).join(","));
  }
  toBuffer(): Buffer {
    return Buffer.from(`${this.lines.join("\r\n")}\r\n`, "utf8");
  }
}

const METRIC_COLUMNS = [
  "metric_date", "engine_key", "entity_type", "entity_id", "cells_total", "cells_present", "presence_rate", "sov", "avg_prominence", "avg_rank_position",
  "mentions_total", "mentions_positive", "mentions_neutral", "mentions_negative", "sentiment_score", "citations_total", "citations_owned", "citation_share",
  "visibility_score", "rendering_quality", "live_capture_ratio", "scoring_version", "computed_at",
] as const;

const ATTRIBUTION_COLUMNS = ["metric_date", "landing_url", "referrer_class", "country", "device", "sessions", "conversions", "conversion_value", "bounce_sessions", "ingested_at"] as const;

// The bytea hashes and the ids the folder already names are not exported; everything else on the fact row is.
const FACT_OMIT = "ARRAY['workspace_id','project_id','url_hash','negative_source_url_hash']";

interface CaptureRow {
  id: string;
  captured_at: Date;
  /** The same instant as text: a JS Date keeps milliseconds, timestamptz keeps microseconds, and a keyset cursor must not round. */
  at_exact: string;
  engine_key: string;
  prompt_id: string;
  sample_index: number;
  capture_mode: string;
  status: string;
  raw_object_key: string;
}

async function exportRaw(deps: BuildDeps, projectId: string, cutoff: Date): Promise<{ jsonl: Buffer; count: number; unreadable: number; oldest: Date | null; newest: Date | null }> {
  const out: string[] = [];
  let count = 0;
  let unreadable = 0;
  let oldest = null as Date | null;
  let newest = null as Date | null;
  let after: { at: string; id: string } | null = null;
  for (;;) {
    const cursor: { at: string; id: string } | null = after;
    const page: { captures: CaptureRow[]; mentions: Map<string, unknown[]>; citations: Map<string, unknown[]> } = await deps.step(async (tx: ClientBase) => {
      const found = await tx.query<CaptureRow>(
        `SELECT id, captured_at, captured_at::text AS at_exact, engine_key, prompt_id, sample_index, capture_mode, status, raw_object_key
           FROM answer_captures
          WHERE workspace_id = $1 AND project_id = $2 AND captured_at < $3 AND raw_object_key IS NOT NULL
            AND ($4::timestamptz IS NULL OR (captured_at, id) > ($4::timestamptz, $5::uuid))
          ORDER BY captured_at, id LIMIT ${String(CAPTURE_PAGE_SIZE)}`,
        [deps.workspaceId, projectId, cutoff.toISOString(), cursor?.at ?? null, cursor?.id ?? null],
      );
      const captures = found.rows;
      const mentions = new Map<string, unknown[]>();
      const citations = new Map<string, unknown[]>();
      if (captures.length > 0) {
        const ids = captures.map((c) => c.id);
        const lo = captures[0]!.at_exact;
        const hi = captures[captures.length - 1]!.at_exact;
        const m = await tx.query<{ result_id: string; fact: unknown }>(
          `SELECT result_id, to_jsonb(f) - ${FACT_OMIT} AS fact FROM mention_facts f
            WHERE workspace_id = $1 AND project_id = $2 AND result_id = ANY($3::uuid[]) AND captured_at BETWEEN $4 AND $5 ORDER BY captured_at, id`,
          [deps.workspaceId, projectId, ids, lo, hi],
        );
        for (const row of m.rows) (mentions.get(row.result_id) ?? mentions.set(row.result_id, []).get(row.result_id)!).push(row.fact);
        const c = await tx.query<{ result_id: string; fact: unknown }>(
          `SELECT result_id, to_jsonb(f) - ${FACT_OMIT} AS fact FROM citation_facts f
            WHERE workspace_id = $1 AND project_id = $2 AND result_id = ANY($3::uuid[]) AND captured_at BETWEEN $4 AND $5 ORDER BY captured_at, id`,
          [deps.workspaceId, projectId, ids, lo, hi],
        );
        for (const row of c.rows) (citations.get(row.result_id) ?? citations.set(row.result_id, []).get(row.result_id)!).push(row.fact);
      }
      return { captures, mentions, citations };
    });
    if (page.captures.length === 0) break;
    // No transaction is open here: the objects are read between the pages.
    for (const capture of page.captures) {
      let raw: unknown;
      try {
        raw = decodeRawObject(await deps.readRaw(capture.raw_object_key));
      } catch (error) {
        if (error instanceof RawObjectCorruptError || (error instanceof Error && error.name === "NotFoundError")) {
          unreadable += 1;
          continue;
        }
        throw error;
      }
      out.push(
        JSON.stringify({
          result_id: capture.id,
          captured_at: capture.captured_at.toISOString(),
          engine_key: capture.engine_key,
          prompt_id: capture.prompt_id,
          sample_index: capture.sample_index,
          capture_mode: capture.capture_mode,
          status: capture.status,
          raw,
          mention_facts: page.mentions.get(capture.id) ?? [],
          citation_facts: page.citations.get(capture.id) ?? [],
        }),
      );
      count += 1;
      oldest = oldest === null || capture.captured_at < oldest ? capture.captured_at : oldest;
      newest = newest === null || capture.captured_at > newest ? capture.captured_at : newest;
    }
    const last = page.captures[page.captures.length - 1]!;
    after = { at: last.at_exact, id: last.id };
    if (page.captures.length < CAPTURE_PAGE_SIZE) break;
  }
  return { jsonl: Buffer.from(out.length === 0 ? "" : `${out.join("\n")}\n`, "utf8"), count, unreadable, oldest, newest };
}

async function exportRollups(deps: BuildDeps, projectId: string, cutoff: Date): Promise<{ csv: Buffer; days: number; oldest: string | null; newest: string | null }> {
  const file = new CsvFile(METRIC_COLUMNS);
  const days = new Set<string>();
  let after: string[] | null = null;
  for (;;) {
    const cursor: string[] | null = after;
    const rows: Array<Record<string, unknown>> = await deps.step(async (tx: ClientBase) => {
      const r = await tx.query<Record<string, unknown>>(
        `SELECT metric_date::text AS metric_date, engine_key, entity_type, entity_id, cells_total, cells_present, presence_rate, sov, avg_prominence, avg_rank_position,
                mentions_total, mentions_positive, mentions_neutral, mentions_negative, sentiment_score, citations_total, citations_owned, citation_share,
                visibility_score::text AS visibility_score, rendering_quality::text AS rendering_quality, live_capture_ratio, scoring_version, computed_at
           FROM metric_daily
          WHERE workspace_id = $1 AND project_id = $2 AND metric_date < $3::date
            AND ($4::date IS NULL OR (metric_date, engine_key, entity_type, entity_id, scoring_version) > ($4::date, $5, $6, $7::uuid, $8))
          ORDER BY metric_date, engine_key, entity_type, entity_id, scoring_version LIMIT ${String(ROLLUP_PAGE_SIZE)}`,
        [deps.workspaceId, projectId, cutoff.toISOString().slice(0, 10), cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, cursor?.[3] ?? null, cursor?.[4] ?? null],
      );
      return r.rows;
    });
    for (const row of rows) {
      file.add(METRIC_COLUMNS.map((c) => row[c]));
      days.add(String(row.metric_date));
    }
    const last = rows[rows.length - 1];
    if (rows.length < ROLLUP_PAGE_SIZE || last === undefined) break;
    after = [last.metric_date, last.engine_key, last.entity_type, last.entity_id, last.scoring_version].map(String);
  }
  const sorted = [...days].sort();
  return { csv: file.toBuffer(), days: days.size, oldest: sorted[0] ?? null, newest: sorted[sorted.length - 1] ?? null };
}

async function exportAttribution(deps: BuildDeps, projectId: string, cutoff: Date): Promise<{ csv: Buffer; days: number; oldest: string | null; newest: string | null }> {
  const file = new CsvFile(ATTRIBUTION_COLUMNS);
  const days = new Set<string>();
  let after: string[] | null = null;
  for (;;) {
    const cursor: string[] | null = after;
    const rows: Array<Record<string, unknown>> = await deps.step(async (tx: ClientBase) => {
      const r = await tx.query<Record<string, unknown>>(
        `SELECT metric_date::text AS metric_date, landing_url, referrer_class, country, device, sessions, conversions, conversion_value::text AS conversion_value,
                bounce_sessions, ingested_at, encode(landing_url_hash, 'hex') AS hash_hex
           FROM attribution_daily
          WHERE workspace_id = $1 AND project_id = $2 AND metric_date < $3::date
            AND ($4::date IS NULL OR (metric_date, landing_url_hash, referrer_class, country, device) > ($4::date, decode($5, 'hex'), $6, $7, $8))
          ORDER BY metric_date, landing_url_hash, referrer_class, country, device LIMIT ${String(ROLLUP_PAGE_SIZE)}`,
        [deps.workspaceId, projectId, cutoff.toISOString().slice(0, 10), cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, cursor?.[3] ?? null, cursor?.[4] ?? null],
      );
      return r.rows;
    });
    for (const row of rows) {
      file.add(ATTRIBUTION_COLUMNS.map((c) => row[c]));
      days.add(String(row.metric_date));
    }
    const last = rows[rows.length - 1];
    if (rows.length < ROLLUP_PAGE_SIZE || last === undefined) break;
    after = [last.metric_date, last.hash_hex, last.referrer_class, last.country, last.device].map(String);
  }
  const sorted = [...days].sort();
  return { csv: file.toBuffer(), days: days.size, oldest: sorted[0] ?? null, newest: sorted[sorted.length - 1] ?? null };
}

/** Builds the archive and its coverage. Each project's reads run under that project's export lock. */
export async function buildRetentionExport(deps: BuildDeps): Promise<BuiltExport> {
  const { scope } = deps;
  const entries: ZipEntry[] = [];
  const projects: RetentionExportCoverage["projects"] = [];

  for (const project of deps.projects) {
    const folder = projectFolder(project.name, project.projectId);
    const built = await deps.lockProject(project.projectId, async () => ({
      raw: scope.raw === null ? null : await exportRaw(deps, project.projectId, scope.raw.cutoff),
      rollups: scope.rollups === null ? null : await exportRollups(deps, project.projectId, scope.rollups.cutoff),
      attribution: scope.rollups === null ? null : await exportAttribution(deps, project.projectId, scope.rollups.cutoff),
    }));
    if (built.raw !== null) entries.push({ name: `${folder}/answers.jsonl`, data: built.raw.jsonl });
    if (built.rollups !== null) entries.push({ name: `${folder}/metric_daily.csv`, data: built.rollups.csv });
    if (built.attribution !== null) entries.push({ name: `${folder}/attribution_daily.csv`, data: built.attribution.csv });
    projects.push({
      project_id: project.projectId,
      name: project.name,
      folder,
      raw_answers:
        scope.raw === null || built.raw === null
          ? null
          : { cutoff: scope.raw.cutoff.toISOString(), count: built.raw.count, unreadable: built.raw.unreadable, oldest: built.raw.oldest?.toISOString() ?? null, newest: built.raw.newest?.toISOString() ?? null },
      rollups:
        scope.rollups === null || built.rollups === null
          ? null
          : { cutoff: scope.rollups.cutoff.toISOString(), count: built.rollups.days, oldest: built.rollups.oldest, newest: built.rollups.newest },
      attribution:
        scope.rollups === null || built.attribution === null
          ? null
          : { cutoff: scope.rollups.cutoff.toISOString(), count: built.attribution.days, oldest: built.attribution.oldest, newest: built.attribution.newest },
    });
  }

  const coverage: RetentionExportCoverage = {
    generated_at: deps.now.toISOString(),
    purge_not_before: scope.purgeNotBefore.toISOString(),
    complete: projects.every((p) => (p.raw_answers?.unreadable ?? 0) === 0),
    projects,
  };
  entries.unshift({ name: "manifest.json", data: Buffer.from(`${JSON.stringify(coverage, null, 2)}\n`, "utf8") });
  return { zip: createZip(entries, deps.now), coverage };
}
