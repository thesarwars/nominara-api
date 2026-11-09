import { describe, expect, it } from "vitest";
import { parseGscProperty, propertyMatchesDomain } from "./property.js";

// STORY-115 C2/C3 - the property is validated against the project's verified domain, and both property types are handled.
describe("STORY-115 property parsing and domain validation", () => {
  it("S115-3a: a domain property is recognised and typed `domain`", () => {
    expect(parseGscProperty("sc-domain:Shop.Example.com")).toEqual({ type: "domain", host: "shop.example.com", normalised: "sc-domain:shop.example.com" });
  });

  it("S115-3b: a URL-prefix property is recognised and typed `url_prefix`", () => {
    expect(parseGscProperty("https://shop.example.com/")).toEqual({ type: "url_prefix", host: "shop.example.com", normalised: "https://shop.example.com/" });
    expect(parseGscProperty("https://shop.example.com/blog/")?.type).toBe("url_prefix");
  });

  it.each(["", "shop.example.com", "ftp://shop.example.com/", "sc-domain:", "sc-domain:not a host", "https://user:pw@shop.example.com/", "https://shop.example.com/?q=1", "https://shop.example.com/#x", "javascript:alert(1)"])(
    "S115-3c: %j is not a property",
    (raw) => {
      expect(parseGscProperty(raw)).toBeNull();
    },
  );

  it("S115-2a: a property on the project's own host matches, www and case ignored", () => {
    expect(propertyMatchesDomain(parseGscProperty("https://www.shop.example.com/")!, "shop.example.com")).toBe(true);
    expect(propertyMatchesDomain(parseGscProperty("sc-domain:SHOP.example.com")!, "Shop.Example.com")).toBe(true);
  });

  it("S115-2b: a domain property covers the project's subdomain, a URL-prefix property does not widen", () => {
    expect(propertyMatchesDomain(parseGscProperty("sc-domain:example.com")!, "shop.example.com")).toBe(true);
    expect(propertyMatchesDomain(parseGscProperty("https://example.com/")!, "shop.example.com")).toBe(false);
  });

  it.each([
    ["sc-domain:example.org", "shop.example.com"],
    ["https://other.example.com/", "shop.example.com"],
    ["sc-domain:ample.com", "shop.example.com"],
    ["sc-domain:notexample.com", "shop.example.com"],
    ["sc-domain:shop.example.com", "example.com"],
    ["https://shop.example.com.evil.test/", "shop.example.com"],
  ])("S115-2c: %s does not match project domain %s", (property, domain) => {
    expect(propertyMatchesDomain(parseGscProperty(property)!, domain)).toBe(false);
  });
});
