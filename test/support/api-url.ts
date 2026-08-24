import { API_VERSION_PREFIX } from "../../src/api/configure-app.js";

// STORY-023 (EPIC-03 execution plan, decision D1) — every prefixed route a
// test hits over HTTP goes through this helper so the prefix is asserted
// from the same source configureApp() uses, never re-derived. The health
// probes are excluded from the prefix by D1 and must keep being injected at
// their bare, unprefixed paths — do not route them through this helper.
export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `/${API_VERSION_PREFIX}${normalizedPath}`;
}
