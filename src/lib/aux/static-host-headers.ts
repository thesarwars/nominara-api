// STORY-102 / batch 19 fix - the host's own headers file, read for ONE header: X-Robots-Tag.
//
// A directory of built HTML holds no response, but static hosts declare response headers in a file that ships with the build: Netlify and Cloudflare
// Pages read `_headers`, Vercel reads `headers` in `vercel.json`. A `noai` directive delivered that way is exactly what AUX-R-006 looks for, and it is
// in the directory, so the audit reads it instead of reporting a rule it could have decided as unseen.
//
// ONLY X-Robots-Tag is taken. The audit decides nothing else from a header (the response rules are not evaluated at all here), and reading more
// would imply it checks them.
//
// PURE: text in, rules out. A path pattern this reader cannot interpret is not guessed at narrowly: it is APPLIED TO EVERY PAGE and flagged
// `approximate`, because a directive wrongly read as global shows up as a finding someone looks at, and one wrongly read as absent is the failure the
// rule exists to catch.

export interface HostHeaderRule {
  /** The path pattern as the host file wrote it (for the report). */
  readonly source: string;
  /** Every X-Robots-Tag value the rule sets, one entry per header line (they are NOT joined: a scope opened in one value must not leak into the next). */
  readonly robotsTags: readonly string[];
  /** True when the pattern used syntax this reader does not model and the rule is therefore applied to every page. */
  readonly approximate: boolean;
}

export class HostHeadersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostHeadersError";
  }
}

const ROBOTS_HEADER = /^x-robots-tag$/i;

/** Netlify / Cloudflare Pages `_headers`: an unindented path line, then indented `Name: value` lines. */
export function parseHeadersFile(text: string): HostHeaderRule[] {
  const rules: HostHeaderRule[] = [];
  let current: { source: string; tags: string[] } | null = null;
  const flush = (): void => {
    if (current !== null && current.tags.length > 0) rules.push({ source: current.source, robotsTags: current.tags, approximate: isApproximate(current.source) });
  };
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (/^\s/.test(raw)) {
      const colon = raw.indexOf(":");
      if (current !== null && colon > 0 && ROBOTS_HEADER.test(raw.slice(0, colon).trim())) current.tags.push(raw.slice(colon + 1).trim());
      continue;
    }
    flush();
    current = { source: stripOrigin(raw.trim()), tags: [] };
  }
  flush();
  return rules;
}

/**
 * `vercel.json`. Returns null when the file declares no `headers` array (it is then not a headers file for this purpose: the host may still add headers
 * some other way, so the audit does not claim to have seen them). Throws HostHeadersError on JSON that does not parse or a `headers` of the wrong shape:
 * a headers file that cannot be read is an audit that cannot say what it saw.
 */
export function parseVercelJson(text: string): HostHeaderRule[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HostHeadersError("vercel.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !("headers" in parsed)) return null;
  const headers = (parsed as { headers: unknown }).headers;
  if (!Array.isArray(headers)) throw new HostHeadersError("vercel.json `headers` must be an array");
  const rules: HostHeaderRule[] = [];
  for (const entry of headers as unknown[]) {
    if (typeof entry !== "object" || entry === null) throw new HostHeadersError("vercel.json `headers` entries must be objects");
    const { source, headers: list } = entry as { source?: unknown; headers?: unknown };
    if (typeof source !== "string" || !Array.isArray(list)) throw new HostHeadersError("vercel.json `headers` entries need a `source` and a `headers` array");
    const tags: string[] = [];
    for (const header of list as unknown[]) {
      const { key, value } = (header ?? {}) as { key?: unknown; value?: unknown };
      if (typeof key === "string" && typeof value === "string" && ROBOTS_HEADER.test(key.trim())) tags.push(value.trim());
    }
    if (tags.length > 0) rules.push({ source, robotsTags: tags, approximate: isApproximate(source) });
  }
  return rules;
}

function stripOrigin(source: string): string {
  const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(source);
  return m === null ? source : (m[1] ?? "/");
}

/** Syntax this reader models: literal segments, `*` and `:name` placeholders, and Vercel's `(.*)` / `:name*`. Any other group or modifier is not. */
function isApproximate(source: string): boolean {
  const withoutKnown = source.replaceAll("(.*)", "").replace(/:[A-Za-z_][A-Za-z0-9_]*\*/g, "").replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "");
  return /[()[\]{}?+|\\^$]/.test(withoutKnown);
}

function normalise(path: string): string {
  let p = path.replace(/\/index\.html$/, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p === "" ? "/" : p;
}

function toRegExp(source: string): RegExp {
  let p = normalise(source);
  // `/docs/*`, `/docs/:rest*` and `/docs/(.*)` all match `/docs` itself as well as everything under it.
  p = p.replace(/\/(\*|\(\.\*\)|:[A-Za-z_][A-Za-z0-9_]*\*)$/, "\u0000");
  let out = "";
  for (let i = 0; i < p.length; i += 1) {
    const rest = p.slice(i);
    const placeholder = /^:[A-Za-z_][A-Za-z0-9_]*\*/.exec(rest) ?? /^\(\.\*\)/.exec(rest);
    if (p[i] === "\u0000") out += "(?:/.*)?";
    else if (placeholder !== null) {
      out += ".*";
      i += placeholder[0].length - 1;
    } else if (p[i] === "*") out += ".*";
    else if (p[i] === ":" && /^:[A-Za-z_]/.test(rest)) {
      out += "[^/]+";
      i += /^:[A-Za-z_][A-Za-z0-9_]*/.exec(rest)![0].length - 1;
    } else out += p[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** The X-Robots-Tag values that apply to a page served at `path`, in file order; one entry per header line. */
export function robotsTagsFor(rules: readonly HostHeaderRule[], path: string): string[] {
  const target = normalise(path);
  const out: string[] = [];
  for (const rule of rules) {
    let matches: boolean;
    try {
      matches = rule.approximate || toRegExp(rule.source).test(target);
    } catch {
      matches = true;
    }
    if (matches) out.push(...rule.robotsTags);
  }
  return out;
}

/** Ten letters in `x-robots-tag`, so ten bits: 1024 distinct spellings. */
const MAX_VALUES_PER_PAGE = 1 << 10;

/** `x-robots-tag` spelled in the n-th distinct letter case, so n separate values can sit in a header record that is keyed by name (the reader lowercases the key). */
export function robotsHeaderKey(n: number): string {
  if (n >= MAX_VALUES_PER_PAGE) throw new HostHeadersError("a page matches more than 1024 X-Robots-Tag header lines");
  let bit = 0;
  return [..."x-robots-tag"].map((ch) => (ch === "-" ? ch : (n >> bit++) & 1 ? ch.toUpperCase() : ch)).join("");
}
