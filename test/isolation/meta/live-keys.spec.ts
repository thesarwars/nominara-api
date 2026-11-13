import { describe, expect, it } from "vitest";
import { classifyCacheKeys, classifyObjectKeys } from "../support/live-keys.js";

// STORY-012 AC8 - the live-key judges can fail. Each branch is shown on a planted violation, so a judge that has quietly stopped judging is caught here
// before it is trusted against a real Valkey or bucket (the same anti-vacuity rule ISO-00 states for the data path).
const A = "0192f1a0-0000-7000-8000-00000000000a";
const B = "0192f1a0-0000-7000-8000-00000000000b";
const C = "0192f1a0-0000-7000-8000-00000000000c";
const NOBODY = "0192f1a0-0000-7000-8000-0000000000ff";
const cache = (keys: string[]) => classifyCacheKeys(keys, { env: "test", tenantIds: [A, B, C] });

describe("STORY-012 AC8 · ISO-13 live cache key judge", () => {
  it("accepts the three allowed shapes and groups tenant keys by workspace", () => {
    const report = cache([`test:${A}:rl:reads:${A}`, `test:${B}:idem:abc`, "test:global:capture:l1:xyz", "test:socket.io#/#"]);
    expect(report.violations).toEqual([]);
    expect([...report.tenantKeys.keys()].sort()).toEqual([A, B]);
    expect(report.globalKeys).toEqual(["test:global:capture:l1:xyz"]);
    expect(report.otherKeys).toEqual(["test:socket.io#/#"]);
  });

  it("flags a tenant key with no deployment namespace, and any key with none", () => {
    const report = cache([`${A}:rl:reads`, "session:abc"]);
    expect(report.violations.map((v) => v.reason)).toEqual(["a tenant key with no deployment namespace", "no deployment namespace"]);
  });

  it("flags a tenant identifier outside segment 2, in the global namespace, naming two tenants, or naming no tenant at all", () => {
    const report = cache([`test:rl:${A}`, `test:global:${B}:x`, `test:${A}:thing:${B}`, `test:${NOBODY}:x`]);
    expect(report.violations.map((v) => v.reason)).toEqual([
      "a tenant identifier outside segment 2",
      "a tenant identifier inside the global namespace",
      "one key names two tenants",
      "segment 2 is a workspace id that belongs to no tenant",
    ]);
  });

  it("repeating one's own workspace id inside its key (a rate-limit subject) is not a violation", () => {
    expect(cache([`test:${A}:rl:writes:workspace:r60000:${A}`]).violations).toEqual([]);
  });

  it("an empty keyspace yields an empty report (the caller must decide whether that is enough)", () => {
    const report = cache([]);
    expect(report.tenantKeys.size).toBe(0);
    expect(report.violations).toEqual([]);
  });
});

describe("STORY-012 AC8 · ISO-14 live object key judge", () => {
  const judge = (objects: { bucket: string; key: string }[]) => classifyObjectKeys(objects, { env: "inttest", tenantIds: [A, B, C], reportsBucket: "reports" });

  it("accepts {env}/{ws}/… in both buckets and {env}/{ws}/crawl/… in the raw bucket", () => {
    const report = judge([
      { bucket: "raw", key: `inttest/${A}/2026/10/x.json.gz` },
      { bucket: "reports", key: `inttest/${B}/r.pdf` },
      { bucket: "raw", key: `inttest/${A}/crawl/audit1/dom.gz` },
    ]);
    expect(report.violations).toEqual([]);
    expect(report.byWorkspace.get(A)).toHaveLength(2);
    expect(report.byWorkspace.get(B)).toHaveLength(1);
  });

  it("flags the segments in the wrong order, a missing workspace, a missing environment, and an unknown workspace", () => {
    const report = judge([
      { bucket: "raw", key: `${A}/inttest/x` },
      { bucket: "raw", key: "inttest/x/y" },
      { bucket: "raw", key: `x/${A}/y` },
      { bucket: "raw", key: `inttest/${NOBODY}/y` },
    ]);
    expect(report.violations.map((v) => v.reason)).toEqual([
      "the key does not open with the deployment namespace",
      "no workspace id where the prefix puts one",
      "the key does not open with the deployment namespace",
      "the prefix names a workspace that belongs to no tenant",
    ]);
  });

  it("flags the OLD crawl layout crawl/{env}/{ws}/ by name (owner decision 106(e)), and does not accept it as any other shape", () => {
    const report = judge([{ bucket: "raw", key: `crawl/inttest/${A}/audit1/dom.gz` }, { bucket: "raw", key: `crawl/other/${B}/x` }]);
    expect(report.violations.map((v) => v.reason)).toEqual([
      "the old crawl layout (crawl/{env}/{workspace}/): crawl objects live under {env}/{workspace}/crawl/",
      "the old crawl layout (crawl/{env}/{workspace}/): crawl objects live under {env}/{workspace}/crawl/",
    ]);
    expect(report.byWorkspace.size).toBe(0);
  });

  it("flags a crawl key in the reports bucket, another tenant's id below one's own prefix, and a bare prefix with no object part", () => {
    const report = judge([
      { bucket: "reports", key: `inttest/${A}/crawl/x` },
      { bucket: "raw", key: `inttest/${A}/copy-of/${B}/x` },
      { bucket: "raw", key: `inttest/${A}` },
    ]);
    expect(report.violations.map((v) => v.reason)).toEqual([
      "a crawl key in the reports bucket",
      "the key names another tenant below its own prefix, or has no object part",
      "the key names another tenant below its own prefix, or has no object part",
    ]);
  });
});
