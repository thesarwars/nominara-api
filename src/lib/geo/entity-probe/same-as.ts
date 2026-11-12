// STORY-060 E3 (owner decision 99b) - the brand's own `sameAs` links: the profiles its structured data says it is, read from the JSON-LD (and microdata)
// the STORY-050 document model extracted from the home page. Pure: no fetch, no clock. The coverage audit compares each probed profile's URL with this
// list (`deriveNodeRecord`), so a profile the brand owns but never linked is surfaced as a link gap, which is minutes of work to fix.

const ORGANIZATION_TYPE = /(^|[/#:])(Organization|Corporation|LocalBusiness|NGO|OnlineBusiness|Brand|SoftwareApplication|Store|[A-Za-z]*Business)$/u;

function typesOf(node: Record<string, unknown>): string[] {
  const type = node["@type"] ?? node.type;
  return (Array.isArray(type) ? type : [type]).filter((t): t is string => typeof t === "string");
}

function urlsOf(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) urlsOf(v, out);
    return;
  }
  const raw = typeof value === "string" ? value : typeof value === "object" && value !== null ? (value as Record<string, unknown>)["@id"] : undefined;
  if (typeof raw !== "string") return;
  try {
    const url = new URL(raw.trim());
    if (url.protocol === "http:" || url.protocol === "https:") out.push(url.href);
  } catch {
    // not a URL: not a link
  }
}

/** Every `sameAs` URL of an Organization-like node anywhere in the JSON-LD (including `@graph` and nested nodes), then of microdata Organization items. */
export function brandSameAsFrom(jsonLd: readonly unknown[], microdata: readonly { type?: string; properties: Record<string, unknown[]> }[]): string[] {
  const found: string[] = [];
  const stack: unknown[] = [...jsonLd].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    if (typesOf(record).some((t) => ORGANIZATION_TYPE.test(t))) urlsOf(record.sameAs, found);
    // Children in document order: pushed reversed so they pop in order.
    const children = Object.values(record).filter((v) => typeof v === "object" && v !== null);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  for (const item of microdata) {
    if (item.type !== undefined && ORGANIZATION_TYPE.test(item.type)) urlsOf(item.properties.sameAs, found);
  }
  return [...new Set(found)];
}
