import { describe, expect, it } from "vitest";
import { auditResidency, ResidencyViolationError, type ResidencyResource } from "./residency-audit.js";

const WS_EU = "01990000-0000-7000-8000-0000000000e1";
const WS_US = "01990000-0000-7000-8000-0000000000a1";
const pins = new Map([[WS_EU, "eu-west-1"], [WS_US, "us-east-1"]]);

// STORY-111 AC residency audit, scenarios 25 and 26.
describe("STORY-111 residency audit", () => {
  it("S26 passes when every object of a pinned workspace is inside its region", () => {
    const resources: ResidencyResource[] = [
      { kind: "s3_object", id: `prod/${WS_EU}/a.json`, region: "eu-west-1", workspaceId: WS_EU },
      { kind: "s3_object", id: `prod/${WS_US}/b.json`, region: "us-east-1", workspaceId: WS_US },
    ];
    expect(auditResidency(pins, resources)).toEqual({ checked: 2, violations: [], unattributed: [] });
  });

  it("S26 FAILS LOUDLY on a planted out-of-region object", () => {
    const planted: ResidencyResource = { kind: "s3_object", id: `prod/${WS_EU}/leak.json`, region: "us-east-1", workspaceId: WS_EU };
    expect(() => auditResidency(pins, [planted], { failOnViolation: true })).toThrow(ResidencyViolationError);
    const report = auditResidency(pins, [planted]);
    expect(report.violations).toEqual([{ ...planted, expectedRegion: "eu-west-1" }]);
  });

  it("S26 a resource whose region could not be determined is a violation, never a pass", () => {
    const r = auditResidency(pins, [{ kind: "bucket", id: "b", region: null, workspaceId: WS_EU }]);
    expect(r.violations).toHaveLength(1);
  });

  it("S26 a resource naming a workspace with no region pin is reported, not skipped", () => {
    const r = auditResidency(pins, [{ kind: "s3_object", id: "x", region: "eu-west-1", workspaceId: "01990000-0000-7000-8000-0000000000ff" }]);
    expect(r.violations).toHaveLength(1);
  });

  it("S26 a resource with no workspace is listed as unattributed rather than silently passed", () => {
    const r = auditResidency(pins, [{ kind: "s3_object", id: "shared/x", region: "us-east-1", workspaceId: null }]);
    expect(r.unattributed).toHaveLength(1);
    expect(r.violations).toEqual([]);
  });

  it("S26 an empty inventory still reports zero checked (the audit ran)", () => {
    expect(auditResidency(pins, [])).toEqual({ checked: 0, violations: [], unattributed: [] });
  });
});
