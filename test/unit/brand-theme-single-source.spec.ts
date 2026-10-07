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

/** True when a source file names a branding field but is not the theme row, its contract, or a pure helper over the theme's values. */
function holdsSecondSource(path: string, text: string): boolean {
  const code = stripComments(text); // a comment explaining the theme is not a configuration
  if (!FIELD_RE.test(code)) return false;
  if (path.startsWith("src/lib/theme/")) return false; // pure functions over the theme's own values
  if (path === "contracts/agency/theme.schema.ts") return false; // the theme's contract
  if (path === "src/db/schema/tools.ts") return false; // the brand_themes table (checked above)
  if (/brand_themes|brandThemes/.test(code)) return false; // reads/writes the theme row itself
  if (path.endsWith(".test.ts") || path.endsWith(".spec.ts")) return false; // tests configure nothing
  return true;
}

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
    const offenders = files.filter((file) => holdsSecondSource(rel(file), readFileSync(file, "utf8"))).map(rel);
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
    expect(holdsSecondSource("src/modules/reports/branding.ts", "const t = row.colorBg;")).toBe(true);
    expect(holdsSecondSource("src/modules/agency/x.ts", 'sql`SELECT color_bg FROM brand_themes`')).toBe(false);
    expect(holdsSecondSource("contracts/reports/x.ts", "// survives hide_nominara_brand")).toBe(false);
  });
});
