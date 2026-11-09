import { auxSiteFilesAccessSchema, type AuxSiteFilesAccess } from "../../../contracts/tools/index.js";
import type { Cache } from "../cache/cache.port.js";
import { globalKey } from "../cache/valkey-keys.js";

// STORY-082 AC1 - the site-files check is CACHED PER HOST, so a repeated check costs nothing and adds no load on the site.
//
// KEYED BY ORIGIN (scheme + host + port), never by hostname: http and https, or another port, are different origins with their own robots.txt. The cached reading is
// the SITE-ROOT reading (the verdict for `/`), so it does not depend on the path the asking tenant typed and one tenant's URL cannot shape another's answer.
//
// What is cached is the PUBLIC reading of a host's own well-known files (robots.txt, llms.txt, sitemap) as AI agent access - nothing about the workspace that
// asked - so the key is platform-wide (`globalKey`) and one tenant's check serves another's. A value that does not parse is a miss: the cache is never trusted
// over the schema. PROVISIONAL: the reference states no lifetime; one hour keeps a fixed robots.txt visible within the hour and still absorbs repeat checks.
export const SITE_FILES_CACHE_TTL_MS = 60 * 60 * 1000;

export const siteFilesCacheKey = (env: string, origin: string): string => globalKey(env, "aux-site-files", encodeURIComponent(origin.toLowerCase()));

export async function readSiteFilesCache(cache: Cache, env: string, origin: string): Promise<AuxSiteFilesAccess | null> {
  const raw = await cache.get(siteFilesCacheKey(env, origin));
  if (raw === undefined) return null;
  try {
    const parsed = auxSiteFilesAccessSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writeSiteFilesCache(cache: Cache, env: string, origin: string, value: AuxSiteFilesAccess): Promise<void> {
  await cache.set(siteFilesCacheKey(env, origin), JSON.stringify(value), { ttlMs: SITE_FILES_CACHE_TTL_MS });
}
