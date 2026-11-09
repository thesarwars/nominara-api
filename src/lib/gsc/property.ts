import type { GscPropertyType } from "../../../contracts/integrations/index.js";

// STORY-115 C2/C3 - what a Search Console property is, and whether it belongs to the project.
//
// Search Console names a property two ways: `sc-domain:example.com` (a DOMAIN property, every protocol and subdomain) and a URL prefix
// such as `https://example.com/blog/` (one protocol and host, from a path down). The type is recorded because it decides how far the
// property reaches, and therefore how far it may be trusted to describe this project.
//
// THE MATCH IS DELIBERATELY NARROW. A mismatch is rejected rather than synced, because wrong-site data is indistinguishable from the
// customer's own once it is in the table. A domain property matches the project's host or a subdomain of the property's domain (the
// property covers it); a URL-prefix property matches only the project's own host. `www.` and case are ignored; nothing else is.

export interface GscProperty {
  readonly type: GscPropertyType;
  readonly host: string;
  /** The property in one canonical spelling, as stored. */
  readonly normalised: string;
}

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;
const DOMAIN_PREFIX = "sc-domain:";

const stripWww = (host: string): string => (host.startsWith("www.") ? host.slice(4) : host);

/** The property, or `null` when the string is neither a domain property nor a plain http(s) URL prefix. */
export function parseGscProperty(raw: string): GscProperty | null {
  const value = raw.trim();
  if (value.toLowerCase().startsWith(DOMAIN_PREFIX)) {
    const host = value.slice(DOMAIN_PREFIX.length).toLowerCase();
    if (!HOST.test(host)) return null;
    return { type: "domain", host, normalised: `${DOMAIN_PREFIX}${host}` };
  }
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (!HOST.test(url.hostname)) return null;
  return { type: "url_prefix", host: url.hostname, normalised: url.toString() };
}

/** True when the property describes the project's own domain (FR-GSC-01b). */
export function propertyMatchesDomain(property: GscProperty, rootDomain: string): boolean {
  const project = stripWww(rootDomain.trim().toLowerCase());
  const host = stripWww(property.host);
  if (host === project) return true;
  return property.type === "domain" && project.endsWith(`.${host}`);
}
