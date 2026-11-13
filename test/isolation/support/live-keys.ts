// STORY-012 AC8 / ISO-13, ISO-14 - the judges for keys OBSERVED in a live Valkey and a live object store. The source scanners (iso-13/iso-14) read how keys are
// BUILT; these read what actually landed, which is the property the isolation suite exists for: no key in the store can be reached by another tenant's namespace.
//
// Pure functions, so test/isolation/meta/live-keys.spec.ts shows each one fails on a planted violation without a container. The DEFAULT is to report: a key that
// matches no allowed shape is a violation, and there is no allow-list of exceptions to extend (the shared answer cache's `{env}:global:` form is the one documented
// shape, and it must carry no tenant identifier).

export interface KeyViolation {
  readonly key: string;
  readonly reason: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface CacheKeyReport {
  /** Keys judged to be tenant keys (`{env}:{workspace}:...`), grouped by the workspace they name. */
  readonly tenantKeys: ReadonlyMap<string, readonly string[]>;
  /** `{env}:global:...` keys. */
  readonly globalKeys: readonly string[];
  /** Env-prefixed keys that name no tenant. */
  readonly otherKeys: readonly string[];
  readonly violations: readonly KeyViolation[];
}

/** ISO-13 over the keys a live cache holds. `tenantIds` are the workspace ids that exist (the fixture's three). */
export function classifyCacheKeys(keys: readonly string[], opts: { readonly env: string; readonly tenantIds: readonly string[] }): CacheKeyReport {
  const known = new Set(opts.tenantIds);
  const tenantKeys = new Map<string, string[]>();
  const globalKeys: string[] = [];
  const otherKeys: string[] = [];
  const violations: KeyViolation[] = [];
  for (const key of keys) {
    const segments = key.split(":");
    const tenantsNamed = new Set((key.match(UUID) ?? []).filter((id) => known.has(id)));
    if (segments[0] !== opts.env) {
      violations.push({ key, reason: tenantsNamed.size > 0 ? "a tenant key with no deployment namespace" : "no deployment namespace" });
      continue;
    }
    const second = segments[1] ?? "";
    if (second === "global") {
      if (tenantsNamed.size > 0) violations.push({ key, reason: "a tenant identifier inside the global namespace" });
      else globalKeys.push(key);
      continue;
    }
    if (IS_UUID.test(second)) {
      if (!known.has(second)) violations.push({ key, reason: "segment 2 is a workspace id that belongs to no tenant" });
      else if (tenantsNamed.size > 1) violations.push({ key, reason: "one key names two tenants" });
      else {
        tenantKeys.set(second, [...(tenantKeys.get(second) ?? []), key]);
      }
      continue;
    }
    if (tenantsNamed.size > 0) violations.push({ key, reason: "a tenant identifier outside segment 2" });
    else otherKeys.push(key);
  }
  return { tenantKeys, globalKeys, otherKeys, violations };
}

export interface ObjectKeyRef {
  readonly bucket: string;
  readonly key: string;
}

export interface ObjectKeyReport {
  /** Keys judged namespaced, grouped by the workspace whose prefix holds them. */
  readonly byWorkspace: ReadonlyMap<string, readonly ObjectKeyRef[]>;
  readonly violations: readonly KeyViolation[];
}

/**
 * ISO-14 over the objects a live store holds: `{env}/{workspace_id}/...` (raw and reports), the crawl namespace being `{env}/{workspace_id}/crawl/...` (raw
 * bucket only; owner decision 106(e)), the workspace being one that exists. Anything else, a key under a prefix that names two workspaces, or a crawl key in the reports bucket, is a violation.
 */
export function classifyObjectKeys(objects: readonly ObjectKeyRef[], opts: { readonly env: string; readonly tenantIds: readonly string[]; readonly reportsBucket: string }): ObjectKeyReport {
  const known = new Set(opts.tenantIds);
  const byWorkspace = new Map<string, ObjectKeyRef[]>();
  const violations: KeyViolation[] = [];
  for (const object of objects) {
    const segments = object.key.split("/");
    const env = segments[0];
    const workspace = segments[1];
    const label = `${object.bucket}/${object.key}`;
    if (env === "crawl") {
      // The OLD crawl layout (`crawl/{env}/{ws}/`): moved to `{env}/{ws}/crawl/` by owner decision 106(e). Reported by name so a leftover is not mistaken for noise.
      violations.push({ key: label, reason: "the old crawl layout (crawl/{env}/{workspace}/): crawl objects live under {env}/{workspace}/crawl/" });
    } else if (env !== opts.env) {
      violations.push({ key: label, reason: "the key does not open with the deployment namespace" });
    } else if (workspace === undefined || !IS_UUID.test(workspace)) {
      violations.push({ key: label, reason: "no workspace id where the prefix puts one" });
    } else if (!known.has(workspace)) {
      violations.push({ key: label, reason: "the prefix names a workspace that belongs to no tenant" });
    } else if (segments[2] === "crawl" && object.bucket === opts.reportsBucket) {
      violations.push({ key: label, reason: "a crawl key in the reports bucket" });
    } else if (segments.slice(2).some((segment) => known.has(segment) && segment !== workspace) || segments.length < 3) {
      violations.push({ key: label, reason: "the key names another tenant below its own prefix, or has no object part" });
    } else {
      byWorkspace.set(workspace, [...(byWorkspace.get(workspace) ?? []), object]);
    }
  }
  return { byWorkspace, violations };
}
