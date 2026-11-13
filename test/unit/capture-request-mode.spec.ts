import { describe, expect, it, vi } from "vitest";
import type { CaptureAdapter, CaptureInput } from "../../src/lib/engines/contract.js";
import type { RunTrigger } from "../../src/lib/capture/fair-use.js";

// STORY-032 AC15 (from STORY-029 AC9) - the run trigger chooses the licensed-SERP request mode.
// tracking-engine.md section 3, "Two capture speeds": manual and tool runs are live (a person is watching), scheduled runs queued.

const seen: CaptureInput[] = [];
const adapter = {
  engineKey: "google_aio",
  adapterVersion: "0.1.0+serpapi.1",
  captureMode: "licensed_serp",
  supportsCitations: true,
  capture: vi.fn(async (input: CaptureInput) => {
    seen.push(input);
    return { text: "an answer", format: "plaintext", truncated: false, responseTokensEst: 3, latencyMs: 5, costUsd: 0 };
  }),
} as unknown as CaptureAdapter;

vi.mock("../../src/lib/engines/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/engines/registry.js")>()),
  resolveEngine: () => adapter,
}));

const { requestModeForTrigger } = await import("../../src/lib/capture/plan-run.js");
const { fetchCell } = await import("../../src/lib/capture/execute-cell.js");

const CELL = {
  workspaceId: "00000000-0000-7000-8000-000000000001",
  projectId: "00000000-0000-7000-8000-000000000002",
  runId: "00000000-0000-7000-8000-000000000003",
  promptId: "00000000-0000-7000-8000-000000000004",
  promptText: "best crm",
  engineKey: "google_aio",
  sampleIndex: 0,
  adapterVersion: "0.1.0",
  ttlSeconds: 86_400,
  locale: "en-US",
  personaHint: null,
  normalizerVersion: "v1",
};

describe("STORY-032 AC15 - request mode from the run trigger", () => {
  it("AC15: a manual run is live", () => {
    expect(requestModeForTrigger("manual")).toBe("live");
  });

  it("AC15: a scheduled run is queued", () => {
    expect(requestModeForTrigger("scheduled")).toBe("queued");
  });

  it("AC15: every other trigger is queued - live is the exception a person watching earns, so a new trigger never defaults to the dearer path", () => {
    const others: RunTrigger[] = ["verification", "drift_sample", "conversion_backfill"];
    for (const trigger of others) expect(requestModeForTrigger(trigger), trigger).toBe("queued");
  });

  it("AC15: the cell's requestMode reaches the adapter call unchanged", async () => {
    seen.length = 0;
    await fetchCell({ ...CELL, requestMode: "live" });
    expect(seen[0]?.requestMode).toBe("live");
  });

  it("AC15: a cell with no requestMode sends none, so the adapter's own default (queued) applies", async () => {
    seen.length = 0;
    await fetchCell({ ...CELL });
    expect(seen[0]).toBeDefined();
    expect("requestMode" in seen[0]!).toBe(false);
  });
});
