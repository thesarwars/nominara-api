import { describe, expect, it } from "vitest";
import { extractHtmlSignals } from "./html-signals.js";

// STORY-043 AC10 — the three signals the regex extractor could not read: hero copy, nav structure and logo alt text.
// parse5 is already a dependency (STORY-050's document model); no new package.

describe("STORY-043 · extractHtmlSignals", () => {
  it("reads the hero headline and the lede paragraph that follows it", () => {
    const html = `<body><header><nav><a href="/">Home</a></nav></header>
      <main><h1>  Grow   better  </h1><p>Short.</p><p>The customer platform that brings your teams together.</p></main></body>`;
    const signals = extractHtmlSignals(html);
    expect(signals.heroCopy?.headline).toBe("Grow better");
    expect(signals.heroCopy?.lede).toBe("The customer platform that brings your teams together.");
  });

  it("does not take a lede from past the next heading", () => {
    const html = `<main><h1>Headline</h1><h2>Section</h2><p>This paragraph belongs to the second section entirely.</p></main>`;
    expect(extractHtmlSignals(html).heroCopy).toEqual({ headline: "Headline" });
  });

  it("a page with no h1 has no hero copy — absent, not empty", () => {
    expect(extractHtmlSignals("<main><p>Just prose that is long enough to be a lede.</p></main>").heroCopy).toBeUndefined();
  });

  it("takes the logo alt text, stripped of the word 'logo'", () => {
    const html = `<header><a href="/"><img class="site-logo" src="/l.svg" alt="HubSpot logo"></a></header>`;
    expect(extractHtmlSignals(html).logoAlt).toBe("HubSpot");
  });

  it("ignores an image that is not a logo, and an empty alt", () => {
    expect(extractHtmlSignals(`<img src="/hero.png" alt="Team at work">`).logoAlt).toBeUndefined();
    expect(extractHtmlSignals(`<img class="logo" src="/l.svg" alt="">`).logoAlt).toBeUndefined();
    expect(extractHtmlSignals(`<img class="logo" src="/l.svg" alt="Logo">`).logoAlt).toBeUndefined();
  });

  it("reads product names from the nav's Products menu", () => {
    const html = `<nav><ul>
      <li><a href="/products">Products</a><ul><li><a href="/sales">Sales Hub</a></li><li><a href="/mkt">Marketing Hub</a></li></ul></li>
      <li><a href="/pricing">Pricing</a></li></ul></nav>`;
    expect(extractHtmlSignals(html).navProducts).toEqual(["Sales Hub", "Marketing Hub"]);
  });

  it("no Products menu means no nav products — it never guesses from other menus", () => {
    const html = `<nav><ul><li><a href="/company">Company</a><ul><li><a href="/about">About us</a></li></ul></li></ul></nav>`;
    expect(extractHtmlSignals(html).navProducts).toBeUndefined();
  });

  it("collects comparison and alternatives links with their text", () => {
    const html = `<footer>
      <a href="/compare/hubspot-vs-salesforce">HubSpot vs Salesforce</a>
      <a href="/alternatives/pipedrive">Pipedrive alternatives</a>
      <a href="/about">About</a><a href="mailto:a@b.c">vs mail</a><a href="#vs">vs</a></footer>`;
    expect(extractHtmlSignals(html).comparisonLinks).toEqual([
      { href: "/compare/hubspot-vs-salesforce", text: "HubSpot vs Salesforce" },
      { href: "/alternatives/pipedrive", text: "Pipedrive alternatives" },
    ]);
  });

  it("survives malformed markup and an empty document", () => {
    expect(() => extractHtmlSignals("<div><h1>Unclosed <p>text")).not.toThrow();
    expect(extractHtmlSignals("")).toEqual({ comparisonLinks: [] });
  });
});
