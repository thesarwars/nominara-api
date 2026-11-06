import { describe, expect, it } from "vitest";
import { sanitiseSvg } from "./svg-sanitiser.js";

// STORY-097 · scenario 10 — a vector is sanitised and RE-SERIALISED; the stored file is the one this module produced.
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const CLEAN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><title>Acme</title><rect x="0" y="0" width="200" height="60" fill="#112233"/></svg>';

function ok(svg: string): { svg: string; width: number; height: number; stripped: { construct: string }[] } {
  const r = sanitiseSvg(enc(svg));
  if (!r.ok) throw new Error("expected accepted: " + JSON.stringify(r.refused));
  return r;
}
function refused(svg: string): string[] {
  const r = sanitiseSvg(enc(svg));
  if (r.ok) throw new Error("expected refusal, got " + r.svg);
  return r.refused.map((x) => x.construct);
}

describe("STORY-097 · SVG sanitiser", () => {
  it("accepts a clean logo, reports its declared size, and emits a re-serialised document", () => {
    const r = ok(CLEAN);
    expect(r.width).toBe(200);
    expect(r.height).toBe(60);
    expect(r.svg).toContain("<rect");
    expect(r.stripped).toEqual([]);
  });

  it("scenario 10 · a script element is refused and named", () => {
    expect(refused(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>`)).toContain("script element");
  });
  it("scenario 10 · a foreignObject is refused and named", () => {
    expect(refused(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject><div>x</div></foreignObject></svg>`)).toContain("foreignObject element");
  });
  it("scenario 10 · an external reference (href to another origin, url() to another origin) is refused and named", () => {
    expect(refused(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><use xlink:href="https://evil.test/a.svg#x"/></svg>`)).toContain("external reference");
    expect(refused(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="1" height="1" fill="url(https://evil.test/p)"/></svg>`)).toContain("external reference");
    expect(refused(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><a href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>`)).toContain("external reference");
  });
  it("scenario 10 · all three together are all named in one answer", () => {
    const names = refused(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>x</script><foreignObject/><use href="http://evil.test/a#b"/></svg>`);
    expect(names).toEqual(expect.arrayContaining(["script element", "foreignObject element", "external reference"]));
  });

  it("scenario 10 · the stored bytes are the re-serialised document: nothing from the upload that is not on the allow-list survives", () => {
    const r = ok(`<?xml version="1.0"?><!-- secret --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="x()" data-x="1"><metadata>m</metadata><rect width="1" height="1" onclick="x()" style="fill:red"/></svg>`);
    expect(r.svg).not.toMatch(/onload|onclick|secret|metadata|data-x|style|<\?xml/);
    expect(r.stripped.map((s) => s.construct)).toEqual(expect.arrayContaining(["onload attribute", "onclick attribute", "metadata element", "style attribute", "data-x attribute"]));
  });

  it("an internal #fragment reference is kept; an event handler, doctype and entity declaration are not", () => {
    expect(ok(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="1" height="1" fill="url(#g)"/></svg>`).svg).toContain('fill="url(#g)"');
    expect(refused(`<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>`)).toContain("DOCTYPE declaration");
    expect(refused(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>&xxe;</title></svg>`)).toContain("entity reference");
  });

  it("text is escaped on output, so markup smuggled as text stays text", () => {
    const r = ok(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>a &lt;script&gt; b</title></svg>`);
    expect(r.svg).toContain("&lt;script&gt;");
    expect(r.svg).not.toContain("<script");
  });

  it("malformed, empty, non-svg-root and wrong-namespace input is refused, never partially kept", () => {
    expect(refused("")).toContain("malformed document");
    expect(refused("<svg")).toContain("malformed document");
    expect(refused('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><g></svg>')).toContain("malformed document");
    expect(refused('<html xmlns="http://www.w3.org/1999/xhtml"/>')).toContain("root element is not svg");
    expect(refused('<svg viewBox="0 0 1 1"/>')).toContain("missing svg namespace");
    expect(refused('<svg xmlns="http://www.w3.org/2000/svg"/>')).toContain("no dimensions");
  });

  it("is idempotent: sanitising its own output changes nothing", () => {
    const once = ok(CLEAN).svg;
    expect(ok(once).svg).toBe(once);
  });
});
