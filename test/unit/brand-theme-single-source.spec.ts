import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// STORY-097 AC4 / scenario 1 — "the theme row is the only source of branding;
// grep finds no second branding configuration". Portal, exports and scheduled
// emails take colours, logos, fonts and brand-removal from ONE stored theme
// (`brand_themes`). Three greps, each defaulting to REPORT: a new place that
// holds a branding field fails here and is a design question, not an allow-list entry.
const ROOT = resolve(import.meta.dirname, "../..");

// Snake-case column / field names, and their camelCase Drizzle spellings.
const BRANDING_FIELDS = [
  "logo_light_key", "logo_dark_key", "favicon_key", "color_primary", "color_accent", "color_bg", "color_fg",
  "font_family", "custom_css", "email_from_name", "email_footer_html", "hide_nominara_brand", "report_cover_key",
];
const camel = (s: string): string => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const NAMES = [...BRANDING_FIELDS, ...BRANDING_FIELDS.map(camel)];
const FIELD_RE = new RegExp(`\\b(${NAMES.join("|")})\\b`);

function walk(dir: string, accept: (path: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}
const rel = (p: string): string => relative(ROOT, p);

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// A top-level statement is a chunk that starts at column 0 with a declaration keyword
// (a decorator line belongs to the declaration under it). Exemptions are by SYMBOL:
// a named statement in a named file, never a whole file or directory, so appending a
// second source to an exempt file is still reported.
const DECL_START = /^(?:export\s|const\s|let\s|function\s|async\s|interface\s|type\s|class\s|enum\s|declare\s|import\s|@)/;
interface Statement { readonly name: string; readonly kind: string; readonly text: string }

function statements(code: string): Statement[] {
  const chunks: string[][] = [[]];
  let prevDecorator = false;
  for (const line of code.split("\n")) {
    if (DECL_START.test(line) && !prevDecorator && chunks[chunks.length - 1]!.length > 0) chunks.push([]);
    chunks[chunks.length - 1]!.push(line);
    prevDecorator = /^@\w+(\(.*\))?\s*$/.test(line);
  }
  return chunks.map((lines) => {
    const text = lines.join("\n");
    const head = /^(?:@\w+(?:\(.*\))?\s*\n)?(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(const|let|function|interface|type|class|enum)\s+(\w+)/.exec(text);
    return { name: head?.[2] ?? "", kind: head?.[1] ?? "", text };
  });
}

/** The only symbols that may name a branding field without querying the theme row: the row's own definition, its contract, and pure helpers over its values. */
const THEME_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  "src/db/schema/tools.ts": ["brandThemes"],
  "contracts/agency/theme.schema.ts": ["agencyThemeSchema", "agencyThemeAdminSchema", "updateAgencyThemeRequestSchema", "saveAgencyThemeResponseSchema"],
  "src/lib/theme/contrast.ts": ["PLATFORM_DEFAULT_COLORS", "ThemeColorField", "PAIRS", "validateThemeContrast"],
  "src/lib/theme/export-palette.ts": ["StoredThemeValues", "exportPaletteFrom"],
  "src/modules/agency/agency.service.ts": ["COLOR_FIELDS", "ThemeRow", "COLUMNS", "toTheme", "platformDefaultTheme", "mergedColors"],
};
/** The one symbol that may hold colour VALUES: the platform default palette (D6). Pure black/white contrast picks are neutral, not branding. */
const VALUE_SYMBOLS: Readonly<Record<string, readonly string[]>> = { "src/lib/theme/contrast.ts": ["PLATFORM_DEFAULT_COLORS"] };

const NEUTRAL = /^#(?:0{3}|0{6}|f{3}|f{6})$/i;
const COLOUR_LITERAL = /["'`](#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([^"'`)]*\))["'`]/g;
const ASSET_URL = /["'`]https?:\/\/[^"'`\s]*(?:\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)|fonts\.(?:googleapis|gstatic)\.com)[^"'`\s]*["'`]/i;
const ASSET_NAMED = /\b\w*(?:LOGO|FAVICON|logo|favicon)\w*\s*[:=]\s*["'`]/;

/** Why a source file holds a second branding source (empty when it does not). Every check reports by default. */
function secondSourceFindings(path: string, text: string): string[] {
  if (path.endsWith(".test.ts") || path.endsWith(".spec.ts")) return []; // tests configure nothing
  const code = stripComments(text); // a comment explaining the theme is not a configuration
  const found: string[] = [];
  for (const st of statements(code)) {
    const label = `${path}: ${st.name || st.text.trim().slice(0, 40)}`;
    if (FIELD_RE.test(st.text)) {
      const querysTheRow = (st.kind === "class" || st.kind === "function") && /brand_themes|brandThemes/.test(st.text);
      if (!querysTheRow && !THEME_SYMBOLS[path]?.includes(st.name)) found.push(`${label} names a branding field`);
    }
    if (VALUE_SYMBOLS[path]?.includes(st.name)) continue;
    const colours = [...st.text.matchAll(COLOUR_LITERAL)].filter((m) => !NEUTRAL.test(m[1]!));
    if (colours.length > 0) found.push(`${label} holds a colour literal ${colours[0]![1]!}`);
    if (ASSET_URL.test(st.text) || ASSET_NAMED.test(st.text)) found.push(`${label} holds a logo/font asset`);
  }
  return found;
}
const holdsSecondSource = (path: string, text: string): boolean => secondSourceFindings(path, text).length > 0;

describe("STORY-097 AC4 · the brand theme row is the only source of branding", () => {
  it("STORY-097 AC4 · in the Drizzle schema, only the brand_themes table declares a branding column", () => {
    const owners = new Set<string>();
    for (const file of walk(join(ROOT, "src/db/schema"), (p) => p.endsWith(".ts"))) {
      let table = "";
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const t = /pgTable\(\s*"(\w+)"/.exec(line);
        if (t) table = t[1]!;
        if (FIELD_RE.test(line) && /\b(text|boolean|uuid|jsonb)\(/.test(line)) owners.add(table || `(outside a table) ${rel(file)}`);
      }
    }
    expect([...owners]).toEqual(["brand_themes"]);
  });

  it("STORY-097 AC4 · in migrations, every statement naming a branding column targets brand_themes", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of walk(join(ROOT, "src/db/migrations/sql"), (p) => p.endsWith(".up.sql"))) {
      const sql = readFileSync(file, "utf8").replace(/--[^\n]*/g, "");
      for (const statement of sql.split(/;\s*\n/)) {
        if (!FIELD_RE.test(statement)) continue;
        seen += 1;
        const head = /^\s*(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: ONLY)?|UPDATE|INSERT INTO|COMMENT ON (?:TABLE|COLUMN)|CREATE (?:UNIQUE )?INDEX \w+ ON)\s+(?:public\.)?"?(\w+)/i.exec(statement);
        if (head?.[1] !== "brand_themes") offenders.push(`${rel(file)}: ${statement.trim().slice(0, 80)}`);
      }
    }
    expect(seen).toBeGreaterThan(0); // the scan really saw the brand_themes DDL
    expect(offenders).toEqual([]);
  });

  it("STORY-097 AC4 · in src and contracts, a branding field appears only beside the theme row, its contract, or the pure theme helpers", () => {
    const files = [
      ...walk(join(ROOT, "src"), (p) => p.endsWith(".ts") && !p.includes("/src/db/migrations/")),
      ...walk(join(ROOT, "contracts"), (p) => p.endsWith(".ts")),
    ];
    const offenders = files.flatMap((file) => secondSourceFindings(rel(file), readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("STORY-097 AC4 · no environment variable or config key carries branding", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src/config"), (p) => p.endsWith(".ts"))) {
      for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
        if (/^\s*["']?[A-Z][A-Z0-9_]*(BRAND|LOGO|THEME|FAVICON|FONT)[A-Z0-9_]*["']?\s*:/.test(line)) offenders.push(`${rel(file)}:${String(i + 1)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("STORY-097 AC4 · the scan is live: a planted second source is flagged, the theme row and a comment are not", () => {
    expect(holdsSecondSource("src/modules/reports/branding.ts", 'export const logo = { color_primary: "#000" };')).toBe(true);
    expect(holdsSecondSource("src/modules/reports/branding.ts", "export const t = row.colorBg;")).toBe(true);
    expect(holdsSecondSource("src/modules/agency/x.ts", "export function q() {\n  return sql`SELECT color_bg FROM brand_themes`;\n}")).toBe(false);
    expect(holdsSecondSource("contracts/reports/x.ts", "// survives hide_nominara_brand")).toBe(false);
    expect(holdsSecondSource("src/lib/reports/x.ts", 'export const ink = (l: number) => (l > 0.6 ? "#000000" : "#ffffff");')).toBe(false);
  });

  it("STORY-097 AC4 · the scan is live: M1, M2 and M4 plants stay killed", () => {
    // M1: a second source appended to a file that legitimately reads the theme row.
    const exportService = "@Injectable()\nexport class ExportService {\n  q() { return sql`SELECT color_primary FROM brand_themes`; }\n}\n";
    expect(holdsSecondSource("src/modules/reports/export.service.ts", exportService)).toBe(false);
    expect(
      holdsSecondSource("src/modules/reports/export.service.ts", exportService + 'export const OVERRIDE_BRANDING = { color_primary: "#123456", hide_nominara_brand: true };\n'),
    ).toBe(true);
    // M2: a source made only of values.
    expect(holdsSecondSource("src/modules/reports/branding-defaults.ts", 'export const REPORT_PRIMARY = "#123456";')).toBe(true);
    expect(holdsSecondSource("src/modules/reports/branding-defaults.ts", 'export const REPORT_RGB = "rgb(18, 52, 86)";')).toBe(true);
    expect(holdsSecondSource("src/modules/reports/branding-defaults.ts", 'export const REPORT_LOGO_URL = "https://cdn.example.com/brand/logo.png";')).toBe(true);
    expect(holdsSecondSource("src/modules/reports/branding-defaults.ts", 'export const FONT = "https://fonts.googleapis.com/css2?family=Inter";')).toBe(true);
    expect(holdsSecondSource("src/modules/reports/branding-defaults.ts", 'export const LOGO = "/assets/mark";')).toBe(true);
    // M4: a second source under src/lib/theme (no directory exemption), and appended to the named helpers.
    expect(holdsSecondSource("src/lib/theme/override.ts", 'export const o = { color_primary: "#123456" };')).toBe(true);
    expect(holdsSecondSource("src/lib/theme/export-palette.ts", 'export function exportPaletteFrom() {}\nexport const extra = { color_accent: "x" };\n')).toBe(true);
    expect(holdsSecondSource("src/lib/theme/contrast.ts", 'export const PLATFORM_DEFAULT_COLORS = { color_bg: "#f7f7fc" };\nexport const BRAND = "#123456";\n')).toBe(true);
    expect(holdsSecondSource("src/lib/theme/contrast.ts", 'export const PLATFORM_DEFAULT_COLORS = { color_bg: "#f7f7fc" };\n')).toBe(false);
  });
});
