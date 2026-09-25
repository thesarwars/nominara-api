import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REALTIME_EVENT_PAYLOADS,
  realtimeEventPayloadSchema,
  realtimeFrameSchema,
} from "../../contracts/events/catalog.schema.js";
import {
  REALTIME_COALESCING_MS,
  PRODUCER_ENFORCED_EVENT_RULES,
  REALTIME_DELIVERY_BUDGET,
  REALTIME_EVENT_COUNT,
  REALTIME_EVENT_PRODUCER,
  realtimeEventNameSchema,
} from "../../contracts/events/event-name.schema.js";

// STORY-026 T19/T20 row 9 — the catalog, checked against §11 itself rather
// than against a list transcribed alongside it. A test that reads the same
// hand-copied array the code reads proves only that the copy is self-
// consistent.
//
// AC10 (per-event invalidation keys) is DEFERRED with a named blocker (D4) and
// is asserted ABSENT below, so "deferred" cannot quietly become "forgotten".

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// READS THE REFERENCE ITSELF — FROM ITS COMMITTED MIRROR.
//
// An event list transcribed into the test would only prove the transcription
// matches itself; the whole point is fidelity to §11. So this reads
// api-specification.md, the document, not a copy of our own array.
//
// It used to read `../Nominara-Dev-Docs-main/` beside the repository, which a
// fresh clone does not have — gap G-12, and the one failure in the first CI
// run. STORY-155 settled G-12 as a vendored mirror, the same arrangement as
// docs/plans/dev-plan.md: `docs/references/api-specification.md` is a
// byte-identical copy of the snapshot's file, and
// test/unit/docs-reference-mirror.spec.ts fails wherever the snapshot is
// present and the two differ. The mirror is a copy of the DOCUMENT, not a
// transcription of its contents, so the test still checks the code against
// the specification rather than against itself.
const SPEC_PATH = resolve(REPO_ROOT, "docs/references/api-specification.md");

function readSpec(): string {
  try {
    return readFileSync(SPEC_PATH, "utf8");
  } catch {
    throw new Error(
      `realtime-event-catalog.spec: the mirrored reference is not at ${SPEC_PATH}. It is committed to this ` +
        "repository (STORY-155, gap G-12); re-copy it from the docs snapshot's references/ directory.",
    );
  }
}

const SPEC = readSpec();
const SECTION_11 = SPEC.split("## 11. Realtime events")[1]!.split("## 12.")[0]!;

/** Every backticked `x.y` token in §11's Event column — the reference's own list, not a copy of ours. */
function eventNamesInSpec(): string[] {
  const names = new Set<string>();
  for (const line of SECTION_11.split("\n")) {
    if (!line.startsWith("|")) continue;
    const [, eventCell] = line.split("|");
    if (eventCell === undefined) continue;
    for (const match of eventCell.matchAll(/`([a-z]+\.[a-z_]+)`/g)) names.add(match[1]!);
  }
  return [...names];
}

describe("STORY-026 · the realtime event catalog matches §11", () => {
  // STORY-026 — `resync` and the `4403` `error` frame are NOT §11 table rows:
  // they describe the delivery channel's own state, not the workspace's, and
  // only the gateway can produce them. They were nonetheless already on the
  // wire while the catalog called itself a closed union and contained
  // neither, so clients had to handle two events nothing typed.
  //
  // Named explicitly rather than allowed as slack in the count: a third
  // addition must be a deliberate edit here, not something that slips in
  // because the number happened to move.
  const GATEWAY_CONTROL_FRAMES = ["resync", "error"];

  it("carries exactly the events §11 names, plus the two gateway control frames", () => {
    const fromSpec = eventNamesInSpec().sort();
    expect(fromSpec, "§11's own table").toHaveLength(19);
    expect(realtimeEventNameSchema.options.slice().sort()).toEqual([...fromSpec, ...GATEWAY_CONTROL_FRAMES].sort());
    expect(REALTIME_EVENT_COUNT).toBe(19 + GATEWAY_CONTROL_FRAMES.length);
  });

  it("binds a payload schema to every event, and no payload to an event §11 does not name", () => {
    expect(Object.keys(REALTIME_EVENT_PAYLOADS).sort()).toEqual(realtimeEventNameSchema.options.slice().sort());
  });

  it("names a producer for every event", () => {
    expect(Object.keys(REALTIME_EVENT_PRODUCER).sort()).toEqual(realtimeEventNameSchema.options.slice().sort());
  });

  it("resolves a payload schema when the event name is data rather than a literal", () => {
    expect(realtimeEventPayloadSchema("member.changed").safeParse({}).success).toBe(false);
  });

  it("coalesces run.progress at §11's 750 ms, per run", () => {
    expect(REALTIME_COALESCING_MS["run.progress"]).toBe(750);
  });

  it("gives engine.degraded §11's one-per-minute budget", () => {
    expect(REALTIME_COALESCING_MS["engine.degraded"]).toBe(60_000);
  });

  it("budgets only the events §11 marks — an unbudgeted event must not acquire one by accident", () => {
    expect(Object.keys(REALTIME_DELIVERY_BUDGET).sort()).toEqual(
      ["aux.finding_created", "displacement.detected", "engine.degraded", "run.progress", "task.created"].sort(),
    );
  });

  // §11 has EIGHT rules, not five, and this file used to lock the five in as
  // though that were the whole column. The other three are once-per-STATE —
  // per threshold, per cycle — which the gateway cannot honour: its
  // bookkeeping is per-socket and in-memory, so "once per cycle" enforced
  // there is once per socket per process per month. They belong to the
  // producers arriving with EPIC-04.
  //
  // Asserted as a DISJOINT, complete partition so neither list can quietly
  // absorb the other's rows, and so a fourth producer-side rule has to be a
  // deliberate edit here.
  it("§11's other three rules are recorded as producer-enforced, not silently missing", () => {
    expect(Object.keys(PRODUCER_ENFORCED_EVENT_RULES).sort()).toEqual([
      "credits.depleted",
      "credits.threshold",
      "quota.threshold",
    ]);

    const budgeted = new Set<string>(Object.keys(REALTIME_DELIVERY_BUDGET));
    for (const name of Object.keys(PRODUCER_ENFORCED_EVENT_RULES)) {
      expect(budgeted.has(name), `${name} cannot be both gateway-budgeted and producer-enforced`).toBe(false);
    }
  });

  // The distinction this story exists to draw. Replace-latest is right for a
  // percentage and wrong for a creation event carrying a distinct id: under
  // one shared throttle, twenty findings in a second delivered about five and
  // the client never learned of the other fifteen.
  it("the ≤ 5 / s rows are RATE-LIMITED per project, not replace-latest", () => {
    for (const name of ["aux.finding_created", "task.created", "displacement.detected"] as const) {
      expect(REALTIME_DELIVERY_BUDGET[name], name).toEqual({
        kind: "rate_limit",
        perSecond: 5,
        keyField: "project_id",
      });
    }
  });

  it("the derived coalescing table holds the replace-latest events and nothing else", () => {
    expect(Object.keys(REALTIME_COALESCING_MS).sort()).toEqual(["engine.degraded", "run.progress"]);
  });
});

describe("STORY-026 · every payload is strict", () => {
  it.each(Object.entries(REALTIME_EVENT_PAYLOADS))("%s rejects an unrecognised key", (_name, schema) => {
    // NFR-API-02's reasoning applied to the socket: an unknown key is rejected,
    // never ignored. A payload that silently accepted extra fields would let a
    // producer ship one the catalog never described.
    const parsed = schema.safeParse({ definitely_not_a_field: true });
    expect(parsed.success).toBe(false);
  });
});

describe("STORY-026 · NFR-API-05 holds inside event payloads too", () => {
  // §11's table says `eta_seconds`, which NFR-API-05 forbids: "all durations
  // are integer milliseconds with a `_ms` suffix". The unconditional
  // requirement wins over one table cell — the same resolution STORY-117 made
  // for `expires_in_seconds` — and §11 is hand-carried.
  it.each(["capture-events", "analysis-events", "billing-events", "platform-events"])(
    "%s.schema.ts declares no _seconds field",
    (file) => {
      const source = readFileSync(resolve(REPO_ROOT, `contracts/events/${file}.schema.ts`), "utf8");
      expect([...source.matchAll(/^\s*([a-z_]*_seconds)\s*:/gm)].map((m) => m[1])).toEqual([]);
    },
  );

  it("run.progress carries eta_ms, and it is nullable because an eta is not always computable", () => {
    const schema = REALTIME_EVENT_PAYLOADS["run.progress"];
    const base = {
      run_id: "0192f1a0-0000-7000-8000-00000000000a",
      project_id: "0192f1a0-0000-7000-8000-00000000000b",
      planned: 10,
      captured: 4,
      skipped: 0,
      failed: 1,
      pct: 40,
    };
    expect(schema.safeParse({ ...base, eta_ms: 12_000 }).success).toBe(true);
    expect(schema.safeParse({ ...base, eta_ms: null }).success).toBe(true);
    expect(schema.safeParse({ ...base, eta_seconds: 12 }).success).toBe(false);
  });
});

describe("STORY-026 · AC10 is deferred, and stays visibly deferred", () => {
  it("publishes no invalidation key — the keys belong to nominara-app, not here (D4)", () => {
    const frame = realtimeFrameSchema.safeParse({
      event: "member.changed",
      data: {},
      invalidation_key: ["workspaces", "members"],
    });
    expect(frame.success, "an invented invalidation key must not validate").toBe(false);
  });

  it("§11 still has no invalidation-key column — when it gains one, this goes red and AC10 is unblocked", () => {
    const header = SECTION_11.split("\n").find((line) => line.startsWith("| Event"));
    expect(header).toBeDefined();
    expect(header!.toLowerCase()).not.toContain("invalidation");
  });
});
