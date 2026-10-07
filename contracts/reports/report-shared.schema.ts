import { z } from "zod";

// NEW-E-0 (Track E contracts) — vocabulary shared by the export, the
// methodology footer, scheduled reports and the portal. integrations-and-
// sharing.md §4-§5; field names follow lib/api/pending.ts where the spec is
// silent.

/** Report sections. Frontend `ReportSection`; the DB default vocabulary {scorecards,...} is mapped by the service. */
export const reportSectionSchema = z.enum(["overview", "growth_map", "matrix", "competitors", "sources", "tasks", "aux"]);
export type ReportSection = z.infer<typeof reportSectionSchema>;

export const reportFormatSchema = z.enum(["pdf", "csv"]);
export type ReportFormat = z.infer<typeof reportFormatSchema>;

/** The timeframe a report, portal read or token lock can name. `custom` is excluded: it needs a date pair no contract here carries. */
export const reportTimeframeSchema = z.enum(["24h", "7d", "30d", "90d"]);
export type ReportTimeframe = z.infer<typeof reportTimeframeSchema>;

export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
