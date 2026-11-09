import { describe, expect, it } from "vitest";
import { detectPlatform } from "./platform.js";

const page = (head: string, body = "<p>hello</p>") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe("detectPlatform (STORY-195 · FR-ONB-04)", () => {
  it("PL-1 a declared generator is the strongest reading, in either attribute order", () => {
    expect(detectPlatform(page('<meta name="generator" content="WordPress 6.5.2">'))).toEqual({ value: "wordpress", confidence: 0.95 });
    expect(detectPlatform(page('<meta content="Wix.com Website Builder" name="generator">'))).toEqual({ value: "wix", confidence: 0.95 });
    expect(detectPlatform(page('<meta name="generator" content="Ghost 5.1">'))).toEqual({ value: "ghost", confidence: 0.95 });
  });

  it.each([
    ["wordpress", '<link rel="stylesheet" href="https://x.test/wp-content/themes/t/style.css">'],
    ["shopify", '<script src="https://cdn.shopify.com/s/files/1/a.js"></script>'],
    ["wix", '<img src="https://static.wixstatic.com/media/a.png">'],
    ["squarespace", '<script src="https://static1.squarespace.com/static/a.js"></script>'],
    ["webflow", '<link href="https://cdn.prod.website-files.com/a.css" rel="stylesheet">'],
    ["framer", '<img src="https://framerusercontent.com/images/a.png">'],
    ["drupal", '<link href="/sites/default/files/css/a.css" rel="stylesheet">'],
    ["joomla", '<script src="/media/system/js/core.js"></script>'],
    ["hubspot", '<link href="/_hcms/a.css" rel="stylesheet">'],
  ])("PL-2 %s is recognised from an asset URL, at a lower confidence than a declared generator", (platform, head) => {
    expect(detectPlatform(page(head))).toEqual({ value: platform, confidence: 0.85 });
  });

  it("PL-3 a platform named only in prose is NOT a detection (a marker must be in a tag, not in text)", () => {
    expect(detectPlatform(page("", "<p>We migrated from WordPress to our own stack. See wp-content and cdn.shopify.com notes.</p>"))).toBeUndefined();
  });

  it("PL-4 a page with no marker, an empty document and a non-HTML string detect nothing", () => {
    expect(detectPlatform(page('<title>Acme</title>'))).toBeUndefined();
    expect(detectPlatform("")).toBeUndefined();
    expect(detectPlatform("{\"json\":true}")).toBeUndefined();
  });

  it("PL-5 a declared generator outranks an asset marker for another platform", () => {
    const head = '<meta name="generator" content="WordPress 6"><script src="https://cdn.shopify.com/a.js"></script>';
    expect(detectPlatform(page(head))).toEqual({ value: "wordpress", confidence: 0.95 });
  });

  it("PL-6 two different platforms at the same strength are ambiguous, so none is named", () => {
    const head = '<link href="/wp-content/a.css" rel="stylesheet"><script src="https://cdn.shopify.com/a.js"></script>';
    expect(detectPlatform(page(head))).toBeUndefined();
  });

  it("PL-7 the same platform found twice is still one detection", () => {
    const head = '<link href="/wp-content/a.css" rel="stylesheet"><script src="/wp-includes/a.js"></script>';
    expect(detectPlatform(page(head))).toEqual({ value: "wordpress", confidence: 0.85 });
  });

  it("PL-8 an unknown generator is not a platform", () => {
    expect(detectPlatform(page('<meta name="generator" content="Hugo 0.120">'))).toBeUndefined();
  });
});
