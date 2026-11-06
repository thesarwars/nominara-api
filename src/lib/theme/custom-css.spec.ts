import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_CSS_CHARS, sanitiseCustomCss } from "./custom-css.js";

// STORY-097 AC "style override" · FR-AGY-01 integrations-and-sharing.md §2 `custom_css`: a property allow-list, selectors
// restricted to design-system classes, no url()/@import/content/position:fixed, parsed and re-serialised, anything
// unrecognised dropped AND reported back.
function ok(input: string): { css: string; dropped: { kind: string; construct: string; reason: string }[] } {
  const r = sanitiseCustomCss(input);
  if (!r.ok) throw new Error("expected accepted, got refusal: " + JSON.stringify(r.refused));
  return r;
}
function refused(input: string): string[] {
  const r = sanitiseCustomCss(input);
  if (r.ok) throw new Error("expected refusal, got: " + r.css);
  return r.refused.map((x) => x.construct);
}

describe("STORY-097 · custom_css allow-list and re-serialisation", () => {
  it("scenario 12 · a disallowed property and an out-of-scope selector are BOTH dropped and reported back", () => {
    const r = ok(".nm-card{color:#112233;behavior:foo;} .evil{color:red} body{color:red} #app{color:red}");
    expect(r.css).toBe(".nm-card{color:#112233}");
    const reported = r.dropped.map((d) => d.kind + ":" + d.construct);
    expect(reported).toContain("property:behavior");
    expect(reported).toContain("selector:.evil");
    expect(reported).toContain("selector:body");
    expect(reported).toContain("selector:#app");
    for (const d of r.dropped) expect(d.reason.length).toBeGreaterThan(0);
  });

  it("scenario 13 · an external reference, an import, generated content and fixed positioning are each REFUSED, naming the construct", () => {
    expect(refused(".nm-card{background-color:url(https://evil.test/x.png)}")).toEqual(["url()"]);
    expect(refused('@import "https://evil.test/a.css";')).toEqual(["@import"]);
    expect(refused('.nm-card::before{content:"x"}')).toEqual(["content"]);
    expect(refused(".nm-card{position:fixed}")).toEqual(["position: fixed"]);
  });

  it("scenario 13 · obfuscation does not get past the refusal: case, comments, whitespace, escapes", () => {
    expect(refused(".nm-card{POSITION : FIXED}")).toEqual(["position: fixed"]);
    expect(refused(".nm-card{background-color:URL( 'a' )}")).toEqual(["url()"]);
    expect(refused(".nm-card{background-color:u\\72l(a)}")).toContain("escape sequence");
    expect(refused("@IMPORT url(a);")).toContain("@import");
    expect(refused(".nm-card{Content : 'x'}")).toEqual(["content"]);
    expect(refused(".nm-card{position/**/:/**/fixed}")).toEqual(["position: fixed"]);
  });

  it("keeps every allow-listed property family: colours, spacing, radius, font-size, font-weight, letter-spacing, border", () => {
    const r = ok(
      ".nm-card{color:#abc;background-color:rgb(1,2,3);margin-top:4px;padding:8px 12px;gap:1rem;border-radius:6px;" +
        "font-size:14px;font-weight:600;letter-spacing:0.02em;border:1px solid #ddd;border-color:var(--line)}",
    );
    expect(r.dropped).toEqual([]);
    for (const p of ["color:#abc", "background-color:rgb(1,2,3)", "margin-top:4px", "padding:8px 12px", "border-radius:6px", "font-size:14px", "font-weight:600", "letter-spacing:0.02em", "border:1px solid #ddd"]) {
      expect(r.css).toContain(p);
    }
  });

  it("font-family is not in the allow-list (fonts come from the curated set only) and is reported", () => {
    const r = ok(".nm-card{font-family:Comic Sans MS;color:#111}");
    expect(r.css).toBe(".nm-card{color:#111}");
    expect(r.dropped.map((d) => d.construct)).toContain("font-family");
  });

  it("position other than fixed is simply not allow-listed: dropped, not refused", () => {
    const r = ok(".nm-card{position:absolute;color:#111}");
    expect(r.css).toBe(".nm-card{color:#111}");
    expect(r.dropped.map((d) => d.construct)).toContain("position");
  });

  it("an unrecognised value on an allowed property is dropped with the property named", () => {
    const r = ok(".nm-card{color:javascript:alert(1);margin:4px}");
    expect(r.css).toBe(".nm-card{margin:4px}");
    expect(r.dropped[0]).toMatchObject({ kind: "value" });
  });

  it("!important and custom properties are dropped (the override cannot out-rank the token layer)", () => {
    const r = ok(".nm-card{color:#111 !important;--x:1px;margin:2px}");
    expect(r.css).toBe(".nm-card{margin:2px}");
    expect(r.dropped.length).toBe(2);
  });

  it("a selector list keeps the allowed members and reports the rest; descendant and :hover forms of design-system classes pass", () => {
    const r = ok(".nm-card, .evil{color:#111} .nm-card .nm-kpi{color:#222} .nm-button:hover{color:#333} .nm-card[x=y]{color:#444} a{color:#555}");
    expect(r.css).toBe(".nm-card{color:#111}\n.nm-card .nm-kpi{color:#222}\n.nm-button:hover{color:#333}");
    expect(r.dropped.map((d) => d.construct)).toEqual([".evil", ".nm-card[x=y]", "a"]);
  });

  it("other at-rules and nested blocks are dropped and reported, with their content", () => {
    const r = ok("@media (min-width:1px){.nm-card{color:#111}} @charset \"utf-8\"; .nm-card{color:#222}");
    expect(r.css).toBe(".nm-card{color:#222}");
    expect(r.dropped.map((d) => d.kind)).toEqual(["at_rule", "at_rule"]);
  });

  it("boundary and null paths: empty, whitespace, comment-only input; and the size cap", () => {
    expect(ok("")).toMatchObject({ css: "", dropped: [] });
    expect(ok("  /* nothing */  ")).toMatchObject({ css: "", dropped: [] });
    expect(refused("a".repeat(MAX_CUSTOM_CSS_CHARS + 1))).toEqual(["size"]);
    expect(sanitiseCustomCss("a".repeat(MAX_CUSTOM_CSS_CHARS)).ok).toBe(true);
  });

  it("an unterminated block is dropped rather than half-kept, and re-serialising is idempotent", () => {
    const r = ok(".nm-card{color:#111} .nm-kpi{color:#222");
    expect(r.css).toBe(".nm-card{color:#111}");
    expect(ok(r.css).css).toBe(r.css);
  });
});
