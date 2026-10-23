import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PatchRejectedError } from "./types.js";
import { ALLOWED_ELEMENTS, GLOBAL_ATTRIBUTES, buildHtmlFragmentPatch, sanitiseFragment } from "./html-fragment.js";

// STORY-053 AC6 — a markup fragment is sanitised against a strict allow-list, and a script, style, frame or event attribute is
// a HARD ERROR. A silently stripped fragment is a patch that does not do what the diff showed.

const reasonOf = (html: string): { reason: string; detail: unknown } => {
  try {
    sanitiseFragment(html);
  } catch (e) {
    if (e instanceof PatchRejectedError) return { reason: e.reason, detail: e.detail };
    throw e;
  }
  return { reason: "accepted", detail: null };
};

describe("STORY-053 scenario 6 · prohibited markup is a hard error, not a strip", () => {
  it("a fragment containing a script element throws and names the element (it is not returned with the script removed)", () => {
    expect(reasonOf("<p>ok</p><script>alert(1)</script>")).toEqual({ reason: "prohibited_markup", detail: { element: "script" } });
  });

  it.each(["style", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "form", "svg", "math", "template", "noscript"])(
    "a %s element is a hard error",
    (tag) => {
      expect(reasonOf(`<${tag}></${tag}>`).reason).toBe("prohibited_markup");
    },
  );

  it("is case-insensitive and finds the element nested deep", () => {
    expect(reasonOf("<SCRIPT>x</SCRIPT>").reason).toBe("prohibited_markup");
    expect(reasonOf("<div><section><ul><li><IfRaMe src=x></IfRaMe></li></ul></section></div>").reason).toBe("prohibited_markup");
  });

  it.each(["onclick", "onerror", "onload", "onmouseover", "ONFOCUS", "onanimationstart"])("an %s attribute is a hard error, on any element", (attr) => {
    expect(reasonOf(`<p ${attr}="x()">hi</p>`)).toEqual({ reason: "prohibited_markup", detail: { attribute: attr.toLowerCase(), element: "p" } });
    expect(reasonOf(`<img src="https://a.com/i.png" alt="" ${attr}="x()">`).reason).toBe("prohibited_markup");
  });

  it("a javascript:, data: or vbscript: URL is a hard error, even with control characters hiding the scheme", () => {
    expect(reasonOf('<a href="javascript:alert(1)">x</a>').reason).toBe("prohibited_markup");
    expect(reasonOf('<a href="  JaVa\tScRiPt:alert(1)">x</a>').reason).toBe("prohibited_markup");
    expect(reasonOf('<a href="data:text/html,<b>x">x</a>').reason).toBe("prohibited_markup");
    expect(reasonOf('<a href="vbscript:x">x</a>').reason).toBe("prohibited_markup");
  });

  it("an element outside the allow-list is a hard error (the list is an allow-list, not a deny-list)", () => {
    expect(reasonOf("<blink>x</blink>").reason).toBe("prohibited_markup");
    expect(reasonOf("<marquee>x</marquee>").reason).toBe("prohibited_markup");
  });

  it("a style attribute and an unknown attribute are hard errors", () => {
    expect(reasonOf('<p style="x:y">a</p>').reason).toBe("prohibited_markup");
    expect(reasonOf('<p data-x="1">a</p>').reason).toBe("prohibited_markup");
  });

  it("a comment is a hard error (it can carry conditional content a reader never sees)", () => {
    expect(reasonOf("<p>a</p><!--[if IE]><script>x</script><![endif]-->").reason).toBe("prohibited_markup");
  });
});

describe("STORY-053 AC6 · the allow-list itself", () => {
  it("never lists an event-handler attribute, a script-bearing element or a style hook, so an edit to the list cannot reopen the hole the explicit checks close", () => {
    const attributes = [...GLOBAL_ATTRIBUTES, ...[...ALLOWED_ELEMENTS.values()].flatMap((set) => [...set])];
    expect(attributes.filter((a) => a.startsWith("on") || a === "style" || a === "srcdoc" || a === "formaction")).toEqual([]);
    for (const banned of ["script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "svg", "math", "template", "noscript", "base", "html", "head", "body"]) {
      expect(ALLOWED_ELEMENTS.has(banned), banned).toBe(false);
    }
  });
});

describe("STORY-053 AC6 · allowed markup passes and is re-serialised", () => {
  it("passes headings, paragraphs, lists, links, tables and the head tags a rule patch needs", () => {
    const html = '<h2>Question</h2><p>Answer <a href="https://acme.com/x" rel="noopener">link</a></p><ul><li>One</li></ul><table><tbody><tr><td>a</td></tr></tbody></table>';
    expect(sanitiseFragment(html)).toBe(html);
    expect(sanitiseFragment('<meta name="robots" content="index, follow">')).toBe('<meta name="robots" content="index, follow">');
    expect(sanitiseFragment('<link rel="canonical" href="https://acme.com/">')).toBe('<link rel="canonical" href="https://acme.com/">');
  });

  it("returns the PARSED and re-serialised markup, so what is offered is what a browser would build", () => {
    expect(sanitiseFragment("<p>one<p>two")).toBe("<p>one</p><p>two</p>");
  });

  it("escapes text so a stray angle bracket cannot open an element", () => {
    expect(sanitiseFragment("<p>1 &lt; 2 &amp; 3</p>")).toBe("<p>1 &lt; 2 &amp; 3</p>");
  });

  it("an empty fragment is refused (a patch of nothing is not a patch)", () => {
    expect(reasonOf("   ").reason).toBe("malformed_markup");
  });

  it("bounds the size it will parse", () => {
    expect(reasonOf(`<p>${"a".repeat(200_001)}</p>`).reason).toBe("malformed_markup");
  });
});

describe("STORY-053 scenario 1 · an html_fragment patch has a reversal and a precondition hash", () => {
  const page = "<html><head><title>T</title></head><body><h1>Acme</h1></body></html>";
  const d = buildHtmlFragmentPatch({
    ruleCode: "AUX-R-024", targetUrl: "https://acme.com/", pageHtml: page, fragment: '<meta name="robots" content="index, follow">',
    insertion: "head_append", explanation: "e", derivation: "Nominara template: the standard robots meta tag.",
  });

  it("is kind html_fragment, carries the sanitised markup and the sha256 of the page it was made from", () => {
    expect(d.kind).toBe("html_fragment");
    expect(d.contentAfter).toBe('<meta name="robots" content="index, follow">');
    expect(d.contentBeforeHash.equals(createHash("sha256").update(page).digest())).toBe(true);
    expect(d.preconditions[0]).toEqual({ kind: "page_hash", value: `sha256:${createHash("sha256").update(page).digest("hex")}` });
  });

  it("states where it goes and how to remove it", () => {
    expect(d.reversal).toEqual({ operation: "remove_fragment", content: '<meta name="robots" content="index, follow">' });
    expect(d.explanation).toContain("head");
  });

  it("refuses to build from a fragment that is not clean, rather than offering a stripped one", () => {
    expect(() =>
      buildHtmlFragmentPatch({ ruleCode: "AUX-R-024", targetUrl: "https://acme.com/", pageHtml: page, fragment: "<p>a</p><script>1</script>", insertion: "body_append", explanation: "e", derivation: "d" }),
    ).toThrowError(PatchRejectedError);
  });
});
