import type { CaptureEngineGate } from "../../src/lib/engines/capture-engine-gate.js";

// STORY-031 — for the capture.execute specs whose subject is NOT the engine breaker: every cell is admitted and nothing is
// recorded, which is what the handler did before the gate existed. Injected explicitly, because the production default builds a
// breaker on VALKEY_CACHE_URL, and a spec with no cache URL must not dial one. The breaker itself is exercised against a real
// throwaway Valkey in capture-engine-limits.spec.ts.
export const OPEN_ENGINE_GATE: CaptureEngineGate = {
  admit: () => Promise.resolve({ kind: "admit" }),
  record: () => Promise.resolve(),
};
