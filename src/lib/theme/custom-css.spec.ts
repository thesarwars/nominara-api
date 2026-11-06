import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_CSS_LENGTH, MAX_EMAIL_FOOTER_LENGTH } from "../../../contracts/agency/theme.schema.js";
import { MAX_EMAIL_FOOTER_CHARS } from "./email-footer.js";
import { MAX_CUSTOM_CSS_CHARS, sanitiseCustomCss } from "./custom-css.js";
import { type ThemeColors } from "./contrast.js";

const THEME: ThemeColors = { color_primary: null, color_accent: null, color_bg: null, color_fg: null };
const FG = "var(--nm-color-fg)";
const BG = "var(--nm-color-bg)";

// STORY-097 AC "style override" · FR-AGY-01 integrations-and-sharing.md §2 `custom_css`: a property allow-list, selectors
// restricted to design-system classes, no url()/@import/content/position:fixed, parsed and re-serialised, anything
// unrecognised dropped AND reported back.
function ok(input: string, theme: ThemeColors = THEME): { css: string; dropped: { kind: string; construct: string; reason: string }[] } {
  const r = sanitiseCustomCss(input, theme);
  if (!r.ok) throw new Error("expected accepted, got refusal: " + JSON.stringify(r.refused));
  return r;
}
function refused(input: string, theme: ThemeColors = THEME): string[] {
  const r = sanitiseCustomCss(input, theme);
  if (r.ok) throw new Error("expected refusal, got: " + r.css);
  return r.refused.map((x) => x.construct);
}

describe("STORY-097 · custom_css allow-list and re-serialisation", () => {
  it("scenario 12 · a disallowed property and an out-of-scope selector are BOTH dropped and reported back", () => {
    const r = ok(".nm-card{color:var(--nm-color-fg);behavior:foo;} .evil{color:var(--nm-color-fg)} body{color:var(--nm-color-fg)} #app{color:var(--nm-color-fg)}");
    expect(r.css).toBe(".nm-card{color:var(--nm-color-fg)}");
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
      ".nm-card{color:var(--nm-color-fg);background-color:var(--nm-color-bg);margin-top:4px;padding:8px 12px;gap:1rem;border-radius:6px;" +
        "font-size:14px;font-weight:600;letter-spacing:0.02em;border:1px solid var(--nm-color-primary);border-color:var(--nm-color-primary)}",
    );
    expect(r.dropped).toEqual([]);
    for (const p of ["color:var(--nm-color-fg)", "background-color:var(--nm-color-bg)", "margin-top:4px", "padding:8px 12px", "border-radius:6px", "font-size:14px", "font-weight:600", "letter-spacing:0.02em", "border:1px solid var(--nm-color-primary)"]) {
      expect(r.css).toContain(p);
    }
  });

  it("font-family is not in the allow-list (fonts come from the curated set only) and is reported", () => {
    const r = ok(".nm-card{font-family:Comic Sans MS;color:var(--nm-color-fg)}");
    expect(r.css).toBe(".nm-card{color:var(--nm-color-fg)}");
    expect(r.dropped.map((d) => d.construct)).toContain("font-family");
  });

  it("position other than fixed is simply not allow-listed: dropped, not refused", () => {
    const r = ok(".nm-card{position:absolute;color:var(--nm-color-fg)}");
    expect(r.css).toBe(".nm-card{color:var(--nm-color-fg)}");
    expect(r.dropped.map((d) => d.construct)).toContain("position");
  });

  it("an unrecognised value on an allowed property is dropped with the property named", () => {
    const r = ok(".nm-card{color:javascript:alert(1);margin:4px}");
    expect(r.css).toBe(".nm-card{margin:4px}");
    expect(r.dropped[0]).toMatchObject({ kind: "value" });
  });

  it("!important and custom properties are dropped (the override cannot out-rank the token layer)", () => {
    const r = ok(".nm-card{color:var(--nm-color-fg) !important;--x:1px;margin:2px}");
    expect(r.css).toBe(".nm-card{margin:2px}");
    expect(r.dropped.length).toBe(2);
  });

  it("a selector list keeps the allowed members and reports the rest; descendant and :hover forms of design-system classes pass", () => {
    const r = ok(".nm-card, .evil{color:var(--nm-color-fg)} .nm-card .nm-kpi{color:var(--nm-color-fg)} .nm-button:hover{color:var(--nm-color-fg)} .nm-card[x=y]{color:var(--nm-color-fg)} a{color:var(--nm-color-fg)}");
    expect(r.css).toBe(".nm-card{color:var(--nm-color-fg)}\n.nm-card .nm-kpi{color:var(--nm-color-fg)}\n.nm-button:hover{color:var(--nm-color-fg)}");
    expect(r.dropped.map((d) => d.construct)).toEqual([".evil", ".nm-card[x=y]", "a"]);
  });

  it("other at-rules and nested blocks are dropped and reported, with their content", () => {
    const r = ok("@media (min-width:1px){.nm-card{color:var(--nm-color-fg)}} @charset \"utf-8\"; .nm-card{color:var(--nm-color-fg)}");
    expect(r.css).toBe(".nm-card{color:var(--nm-color-fg)}");
    expect(r.dropped.map((d) => d.kind)).toEqual(["at_rule", "at_rule"]);
  });

  it("boundary and null paths: empty, whitespace, comment-only input; and the size cap", () => {
    expect(ok("")).toMatchObject({ css: "", dropped: [] });
    expect(ok("  /* nothing */  ")).toMatchObject({ css: "", dropped: [] });
    expect(refused("a".repeat(MAX_CUSTOM_CSS_CHARS + 1))).toEqual(["size"]);
    expect(sanitiseCustomCss("a".repeat(MAX_CUSTOM_CSS_CHARS), THEME).ok).toBe(true);
  });

  it("a literal colour is dropped and reported: hex, rgb(), hsla() with alpha 0, transparent, a keyword, and an unknown var()", () => {
    for (const v of ["#ffffff", "rgb(255,255,255)", "hsla(0,0%,100%,0)", "transparent", "white", "var(--line)", "var(--nm-color-fg) var(--nm-color-bg)"]) {
      const r = ok(`.nm-card{color:${v};margin:4px}`);
      expect(r.css, v).toBe(".nm-card{margin:4px}");
      expect(r.dropped.map((d) => d.construct), v).toEqual(["color"]);
    }
    for (const prop of ["background-color", "border-color", "outline-color", "border-top-color"]) {
      expect(ok(`.nm-card{${prop}:#fff}`).css, prop).toBe("");
    }
  });

  it("a border shorthand keeps its width and style but drops a literal colour", () => {
    const r = ok(".nm-card{border:1px solid #ffffff;border-left:2px dashed white}");
    expect(r.css).toBe("");
    expect(r.dropped.map((d) => d.construct)).toEqual(["border", "border-left"]);
    expect(ok(".nm-card{border:1px solid var(--nm-color-primary)}").css).toBe(".nm-card{border:1px solid var(--nm-color-primary)}");
  });

  it("scenario 8 · white-on-white through token references is REFUSED with the measured ratio (text colour = background colour)", () => {
    const r = sanitiseCustomCss(`.nm-card{color:${BG};background-color:${BG}}`, THEME);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refused.map((x) => x.construct)).toEqual(["contrast"]);
    expect(r.refused[0]!.message).toContain("1:1");
    expect(r.refused[0]!.message).toContain("4.5:1");
  });

  it("a rule that sets only one side is judged against the theme's own other side", () => {
    expect(refused(`.nm-card{color:${BG}}`)).toEqual(["contrast"]);
    expect(refused(`.nm-card{background-color:${FG}}`)).toEqual(["contrast"]);
    expect(ok(`.nm-card{color:${FG}}`).css).toBe(`.nm-card{color:${FG}}`);
  });

  it("the pair is judged against the THEME'S colours: the same CSS passes on one theme and is refused on another", () => {
    const css = `.nm-button{color:${BG};background-color:var(--nm-color-primary)}`;
    expect(ok(css, { ...THEME, color_primary: "#000000", color_bg: "#ffffff" }).css).toBe(css);
    expect(refused(css, { ...THEME, color_primary: "#eeeeee", color_bg: "#ffffff" })).toEqual(["contrast"]);
  });

  it("a border or outline stroke is held to 3:1 against the background", () => {
    expect(refused(`.nm-card{border:1px solid ${BG}}`)).toEqual(["contrast"]);
    expect(refused(`.nm-card{outline-color:${BG}}`)).toEqual(["contrast"]);
    expect(ok(`.nm-card{border-color:var(--nm-color-primary)}`).dropped).toEqual([]);
  });

  it("values that hide content are dropped and reported: font-size under 10px (or 0), negative margins", () => {
    for (const v of ["0", "9px", "0.5rem", "50%"]) expect(ok(`.nm-card{font-size:${v}}`).dropped.map((d) => d.construct), v).toEqual(["font-size"]);
    expect(ok(".nm-card{font-size:10px}").css).toBe(".nm-card{font-size:10px}");
    expect(ok(".nm-card{font-size:0.625rem}").dropped).toEqual([]);
    for (const v of ["-100vh", "-9999px", "0 -40px"]) expect(ok(`.nm-card{margin:${v}}`).dropped.map((d) => d.construct), v).toEqual(["margin"]);
    expect(ok(".nm-card{margin-top:-8px}").css).toBe("");
    expect(ok(".nm-card{margin:0 auto}").css).toBe(".nm-card{margin:0 auto}");
  });

  it("an unterminated block is dropped rather than half-kept, and re-serialising is idempotent", () => {
    const r = ok(".nm-card{color:var(--nm-color-fg)} .nm-kpi{color:var(--nm-color-fg)");
    expect(r.css).toBe(".nm-card{color:var(--nm-color-fg)}");
    expect(ok(r.css).css).toBe(r.css);
  });
});

describe("STORY-097 · the published limits are the enforced limits", () => {
  it("the contract's maximum lengths equal the sanitisers'", () => {
    expect(MAX_CUSTOM_CSS_LENGTH).toBe(MAX_CUSTOM_CSS_CHARS);
    expect(MAX_EMAIL_FOOTER_LENGTH).toBe(MAX_EMAIL_FOOTER_CHARS);
  });
});
