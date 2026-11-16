import { describe, expect, it, vi } from "vitest";
import * as metrics from "../telemetry/metrics.js";
import { buildAuxDocument, type DocumentSnapshot } from "./document-model.js";
import type { Tokenizer } from "./tokenizer.js";

// STORY-050 AC5 - microdata and RDFa parse errors captured, and microdata `itemref` collected. The error cases are defined in document-model.ts
// (MICRODATA_ERRORS / RDFA_ERRORS); each test here names one of them. A page that is well-formed raises none: false positives are as much a defect as
// silence, because a parse error is a finding.

const tokenizer: Tokenizer = { identity: { name: "test-words", version: "0" }, count: (t) => (t.trim() === "" ? 0 : t.trim().split(/\s+/u).length) };
const snap = (rawHtml: string, renderedHtml: string | null = null): DocumentSnapshot => ({
  url: "https://example.com/p", finalUrl: "https://example.com/p", httpStatus: 200, redirectChain: [], headers: {}, rawHtml, renderedHtml, timing: { ttfbMs: 1, loadMs: 2 },
});
const doc = (body: string, rendered: string | null = null) => buildAuxDocument(snap(`<html><body>${body}</body></html>`, rendered === null ? null : `<html><body>${rendered}</body></html>`), tokenizer);
const errorsOf = (body: string, format: "microdata" | "rdfa") => doc(body).raw.structured.parseErrors.filter((e) => e.format === format);
const reasons = (body: string, format: "microdata" | "rdfa") => errorsOf(body, format).map((e) => e.reason);

describe("STORY-050 AC5 · microdata itemref is collected", () => {
  it("AC5 properties of an element named by itemref belong to the item", () => {
    const d = doc(`<div itemscope itemtype="https://schema.org/Product" itemref="price-box"><span itemprop="name">Widget</span></div><div id="price-box"><span itemprop="price">9.99</span></div>`);
    expect(d.raw.structured.microdata).toEqual([{ type: "https://schema.org/Product", properties: { name: ["Widget"], price: ["9.99"] } }]);
    expect(d.raw.structured.parseErrors).toEqual([]); // the referenced property is NOT an orphan
  });

  it("AC5 the referenced element can itself carry itemprop, and several ids are read in order", () => {
    const d = doc(`<div itemscope itemref="a b"></div><span id="b" itemprop="y">2</span><span id="a" itemprop="x">1</span>`);
    expect(d.raw.structured.microdata).toEqual([{ properties: { x: ["1"], y: ["2"] } }]);
  });

  it("AC5 values keep DOCUMENT order, not itemref order: a property ahead of the scope comes first", () => {
    const d = doc(`<span id="early" itemprop="n">first</span><div itemscope itemref="early late"><span itemprop="n">second</span></div><span id="late" itemprop="n">third</span>`);
    expect(d.raw.structured.microdata[0]!.properties.n).toEqual(["first", "second", "third"]);
  });

  it("AC5 an element reached both as a descendant and by itemref is counted once", () => {
    const d = doc(`<div itemscope itemref="in"><span id="in" itemprop="n">once</span></div>`);
    expect(d.raw.structured.microdata[0]!.properties.n).toEqual(["once"]);
  });

  it("AC5 two items may reference the same element; each gets it", () => {
    const d = doc(`<div itemscope itemref="shared"></div><div itemscope itemref="shared"></div><span id="shared" itemprop="n">x</span>`);
    expect(d.raw.structured.microdata.map((i) => i.properties.n)).toEqual([["x"], ["x"]]);
  });

  it("AC5 a referenced element that is itself an item is a nested item value", () => {
    const d = doc(`<div itemscope itemref="o"></div><div id="o" itemprop="offers" itemscope itemtype="https://schema.org/Offer"><span itemprop="price">1</span></div>`);
    expect(d.raw.structured.microdata[0]!.properties.offers).toEqual([{ type: "https://schema.org/Offer", properties: { price: ["1"] } }]);
  });
});

describe("STORY-050 AC5 · microdata error cases", () => {
  it("AC5 itemprop_outside_scope: an itemprop with no itemscope ancestor and no itemref reaching it", () => {
    const [e] = errorsOf(`<div itemprop="name">orphan</div>`, "microdata");
    expect(e).toMatchObject({ format: "microdata", variant: "raw", reason: "itemprop_outside_scope", index: 0, position: null });
    expect(e!.snippet).toContain('itemprop="name"');
  });

  it("AC5 an itemprop inside a scope, or reached by an itemref, is not an orphan", () => {
    expect(reasons(`<div itemscope><b itemprop="a">x</b></div>`, "microdata")).toEqual([]);
    expect(reasons(`<div itemscope itemref="r"></div><i id="r" itemprop="a">x</i>`, "microdata")).toEqual([]);
  });

  it("AC5 itemref_missing_id: an itemref token naming no element in the document", () => {
    const [e] = errorsOf(`<div itemscope itemref="nope"></div>`, "microdata");
    expect(e).toMatchObject({ reason: "itemref_missing_id" });
    expect(e!.snippet).toContain("nope");
  });

  it("AC5 itemref_missing_id is raised once per missing id, and a found id beside it is still collected", () => {
    const d = doc(`<div itemscope itemref="gone here also-gone"></div><i id="here" itemprop="a">x</i>`);
    expect(d.raw.structured.parseErrors.map((e) => e.reason)).toEqual(["itemref_missing_id", "itemref_missing_id"]);
    expect(d.raw.structured.microdata[0]!.properties.a).toEqual(["x"]);
  });

  it("AC5 itemref_without_itemscope: itemref is only meaningful on an itemscope element", () => {
    expect(reasons(`<div itemref="r"><i id="r">x</i></div>`, "microdata")).toEqual(["itemref_without_itemscope"]);
  });

  it("AC5 itemtype_without_itemscope: itemtype is only meaningful on an itemscope element", () => {
    expect(reasons(`<div itemtype="https://schema.org/Product"></div>`, "microdata")).toEqual(["itemtype_without_itemscope"]);
  });

  it("AC5 empty_itemprop: an itemprop with no name tokens", () => {
    expect(reasons(`<div itemscope><b itemprop="  ">x</b></div>`, "microdata")).toEqual(["empty_itemprop"]);
  });

  it("AC5 itemref_cycle: an item that reaches itself through its own itemref is cut and reported, not recursed into", () => {
    const d = doc(`<div itemscope id="a" itemref="b"></div><div id="b" itemprop="x" itemscope itemref="b"><i itemprop="k">v</i></div>`);
    expect(d.raw.structured.parseErrors.map((e) => e.reason)).toEqual(["itemref_cycle"]);
    // terminated, and the item reached once keeps its own properties
    expect(d.raw.structured.microdata).toEqual([{ properties: { x: [{ properties: { k: ["v"] } }] } }]);
  });

  it("AC5 a page with clean microdata raises nothing", () => {
    expect(doc(`<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">W</span><div itemprop="offers" itemscope><span itemprop="price">1</span></div></div>`).raw.structured.parseErrors).toEqual([]);
  });

  it("AC5 the index is the ordinal of the offending element among the page's microdata elements, in document order", () => {
    const es = errorsOf(`<div itemscope itemref="x"></div><div itemprop="a">o</div>`, "microdata");
    expect(es.map((e) => [e.reason, e.index])).toEqual([["itemref_missing_id", 0], ["itemprop_outside_scope", 1]]);
  });
});

describe("STORY-050 AC5 · RDFa error cases", () => {
  it("AC5 rdfa_missing_vocab: a bare term with no vocab in scope", () => {
    const [e] = errorsOf(`<div typeof="Product"><span property="name">W</span></div>`, "rdfa");
    expect(e).toMatchObject({ format: "rdfa", reason: "rdfa_missing_vocab" });
  });

  it("AC5 rdfa_missing_vocab is satisfied by a vocab on any ancestor, and by a prefixed or absolute name", () => {
    expect(reasons(`<div vocab="https://schema.org/"><div typeof="Product"><span property="name">W</span></div></div>`, "rdfa")).toEqual([]);
    expect(reasons(`<div typeof="schema:Product"><span property="schema:name">W</span></div>`, "rdfa")).toEqual([]);
    expect(reasons(`<div typeof="https://schema.org/Product"><span property="https://schema.org/name">W</span></div>`, "rdfa")).toEqual([]);
  });

  it("AC5 rdfa_undeclared_prefix: a CURIE whose prefix is neither declared nor in the RDFa initial context", () => {
    const [e] = errorsOf(`<div typeof="acme:Widget"></div>`, "rdfa");
    expect(e).toMatchObject({ reason: "rdfa_undeclared_prefix" });
    expect(e!.snippet).toContain("acme:Widget");
  });

  it("AC5 a prefix declared by the prefix attribute (on the element or an ancestor) or by xmlns is declared", () => {
    expect(reasons(`<div prefix="acme: https://acme.test/ns#"><div typeof="acme:Widget"></div></div>`, "rdfa")).toEqual([]);
    expect(reasons(`<div typeof="acme:Widget" prefix="acme: https://acme.test/ns#"></div>`, "rdfa")).toEqual([]);
    expect(reasons(`<div xmlns:acme="https://acme.test/ns#" typeof="acme:Widget"></div>`, "rdfa")).toEqual([]);
  });

  it("AC5 initial-context prefixes (schema, og, dc, foaf, ...) need no declaration, and prefixes compare case-insensitively", () => {
    expect(reasons(`<div typeof="schema:Thing"><i property="og:title dc:creator foaf:name SCHEMA:name">x</i></div>`, "rdfa")).toEqual([]);
  });

  it("AC5 rdfa_malformed_prefix_declaration: a prefix attribute that is not 'name: iri' pairs", () => {
    for (const bad of ["acme", "acme: ", "acme https://x.test/", "acme: not-an-iri", "1bad: https://x.test/", "a: https://x.test/ b:"]) {
      expect(reasons(`<div prefix="${bad}"></div>`, "rdfa"), bad).toEqual(["rdfa_malformed_prefix_declaration"]);
    }
    expect(reasons(`<div prefix="a: https://x.test/ b: https://y.test/"></div>`, "rdfa")).toEqual([]);
  });

  it("AC5 rdfa_malformed_curie: a colon token whose prefix is not a valid name, or whose reference is empty", () => {
    for (const bad of ["1x:Name", "sch ema:x".replace(" ", "$"), "schema:", ":"]) {
      expect(reasons(`<div vocab="https://schema.org/" typeof="${bad}"></div>`, "rdfa"), bad).toContain("rdfa_malformed_curie");
    }
  });

  it("AC5 a property with no typeof is the document's own property: valid, and still checked for vocab", () => {
    expect(reasons(`<span vocab="https://schema.org/" property="name">x</span>`, "rdfa")).toEqual([]);
  });

  it("AC5 a clean RDFa page raises nothing (the extraction test's markup)", () => {
    expect(doc(`<div vocab="https://schema.org/" typeof="Organization"><span property="name">Acme</span><a property="url" href="https://acme.test">site</a></div>`).raw.structured.parseErrors).toEqual([]);
  });

  it("AC5 a page with no RDFa or microdata raises none", () => {
    expect(doc(`<p>plain</p>`).raw.structured.parseErrors).toEqual([]);
  });
});

describe("STORY-050 AC5 · the errors travel with the document", () => {
  it("AC5 each error is counted by format and reason (closed labels, no page text)", () => {
    const spy = vi.spyOn(metrics, "incrementCounter");
    doc(`<div itemprop="a">o</div><div typeof="acme:W"></div>`);
    const mine = spy.mock.calls.filter((c) => c[0] === "nominara_aux_structured_parse_errors_total");
    expect(mine).toEqual([
      ["nominara_aux_structured_parse_errors_total", { format: "microdata", reason: "itemprop_outside_scope" }],
      ["nominara_aux_structured_parse_errors_total", { format: "rdfa", reason: "rdfa_undeclared_prefix" }],
    ]);
    spy.mockRestore();
  });

  it("AC5 a malformation only in the plain copy is reported, tagged raw, and appears in the top-level union", () => {
    const d = doc(`<div itemprop="a">o</div>`, `<p>clean</p>`);
    expect(d.raw.structured.parseErrors.map((e) => e.variant)).toEqual(["raw"]);
    expect(d.rendered!.structured.parseErrors).toEqual([]);
    expect(d.structured.parseErrors.map((e) => [e.format, e.variant, e.reason])).toEqual([["microdata", "raw", "itemprop_outside_scope"]]);
  });

  it("AC5 the snippet is bounded and sanitised, never the page's text", () => {
    const [e] = errorsOf(`<div itemprop="${"x".repeat(1000)}">the secret body text</div>`, "microdata");
    expect(e!.snippet.length).toBeLessThanOrEqual(160);
    expect(e!.snippet).not.toContain("secret");
  });

  it("AC5 is deterministic: the same page builds the same errors twice", () => {
    const html = `<div itemscope itemref="x"></div><div typeof="acme:W"></div><div itemprop="o">o</div>`;
    expect(doc(html).structured.parseErrors).toEqual(doc(html).structured.parseErrors);
  });
});
