import { describe, expect, it } from "vitest";
import { MAX_EMAIL_FOOTER_CHARS, sanitiseEmailFooter } from "./email-footer.js";

// STORY-097 — "Email footer content is a sanitised subset": re-serialised from an allow-list, and what is removed is reported.
function clean(input: string): { html: string; dropped: { construct: string; reason: string }[] } {
  const r = sanitiseEmailFooter(input);
  if (!r.ok) throw new Error("expected accepted: " + r.reason);
  return r;
}

describe("STORY-097 · email footer sanitiser", () => {
  it("keeps the allowed subset and re-serialises it", () => {
    const r = clean('<p>Acme <strong>Ltd</strong><br>See <a href="https://acme.test/p">privacy</a> or <a href="mailto:hi@acme.test">write</a></p>');
    expect(r.html).toBe('<p>Acme <strong>Ltd</strong><br>See <a href="https://acme.test/p">privacy</a> or <a href="mailto:hi@acme.test">write</a></p>');
    expect(r.dropped).toEqual([]);
  });
  it("removes a script element WITH its content, an event handler, a javascript: link, an image and inline style, and reports each", () => {
    const r = clean('<p onclick="x()" style="color:red">a<script>alert(1)</script><img src="https://t.test/p.gif"><a href="javascript:alert(1)">b</a></p>');
    expect(r.html).toBe("<p>a<a>b</a></p>");
    expect(r.dropped.map((d) => d.construct)).toEqual(expect.arrayContaining(["script element", "onclick attribute", "style attribute", "img element", "javascript: link"]));
    expect(r.html).not.toContain("alert");
  });
  it("text is escaped, an unterminated tag cannot leak markup, and unknown tags lose the tag but keep the text", () => {
    expect(clean("1 < 2 & 3 > 2").html).toBe("1 &lt; 2 &amp; 3 &gt; 2");
    expect(clean("a<b").html).toBe("a&lt;b");
    expect(clean("<div>kept</div>").html).toBe("kept");
  });
  it("numeric and common named entities are decoded then re-escaped once; an unknown named entity is dropped and reported", () => {
    expect(clean("&copy; 2026 Acme&nbsp;Ltd &#169; &#x2014; &mdash;").html).toBe("\u00a9 2026 Acme\u00a0Ltd \u00a9 \u2014 \u2014");
    expect(clean("a &amp; b &lt;i&gt;").html).toBe("a &amp; b &lt;i&gt;");
    const r = clean("x &bogus; y");
    expect(r.html).toBe("x  y");
    expect(r.dropped.map((d) => d.construct)).toEqual(["&bogus; entity"]);
  });
  it("a link may only be https or mailto; http, data and protocol-relative are dropped", () => {
    for (const href of ["http://a.test", "data:text/html,x", "//a.test", " JaVaScRiPt:x"]) {
      expect(clean(`<a href="${href}">x</a>`).html).toBe("<a>x</a>");
    }
  });
  it("null path and the size cap", () => {
    expect(sanitiseEmailFooter("")).toEqual({ ok: true, html: "", dropped: [] });
    expect(sanitiseEmailFooter("a".repeat(MAX_EMAIL_FOOTER_CHARS + 1))).toMatchObject({ ok: false });
  });
  it("is idempotent", () => {
    const once = clean('<p onclick="x">a <b>b</b> <a href="https://a.test">c</a></p>').html;
    expect(clean(once).html).toBe(once);
  });
});
