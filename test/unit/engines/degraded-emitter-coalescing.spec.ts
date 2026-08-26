import { describe, expect, it } from "vitest";
import { CoalescingEngineDegradedEmitter } from "../../../src/lib/engines/degraded-emitter-coalescing.js";
import type { EngineDegradedEmitter } from "../../../src/lib/engines/ports.js";

// STORY-031 Phase G stage 5 — AC: "the engine renders with a warning
// wherever it appears... emit the degradation event", coalesced <=1/min/
// engine. Same in-process dedup shape as DlqDepthMonitor's own "pages
// exactly once per sustained breach" (src/lib/queue/dead-letter.ts).

function fakeInnerEmitter() {
  const calls: string[] = [];
  const emitter: EngineDegradedEmitter = { emit: (engineKey) => calls.push(engineKey) };
  return { emitter, calls };
}

describe("STORY-031 · CoalescingEngineDegradedEmitter — at most 1 emit per engine per minute", () => {
  it("the first emit for an engine always passes through", () => {
    const { emitter, calls } = fakeInnerEmitter();
    const nowRef = { now: 0 };
    const coalescing = new CoalescingEngineDegradedEmitter(emitter, 60_000, () => nowRef.now);
    coalescing.emit("chatgpt");
    expect(calls).toEqual(["chatgpt"]);
  });

  it("repeated emits within the same 60s window are suppressed", () => {
    const { emitter, calls } = fakeInnerEmitter();
    const nowRef = { now: 0 };
    const coalescing = new CoalescingEngineDegradedEmitter(emitter, 60_000, () => nowRef.now);
    coalescing.emit("chatgpt");
    nowRef.now = 30_000;
    coalescing.emit("chatgpt");
    nowRef.now = 59_999;
    coalescing.emit("chatgpt");
    expect(calls).toEqual(["chatgpt"]);
  });

  it("exactly at the 60s boundary, a new emit is no longer coalesced", () => {
    const { emitter, calls } = fakeInnerEmitter();
    const nowRef = { now: 0 };
    const coalescing = new CoalescingEngineDegradedEmitter(emitter, 60_000, () => nowRef.now);
    coalescing.emit("chatgpt");
    nowRef.now = 60_000;
    coalescing.emit("chatgpt");
    expect(calls).toEqual(["chatgpt", "chatgpt"]);
  });

  it("each engine coalesces independently", () => {
    const { emitter, calls } = fakeInnerEmitter();
    const nowRef = { now: 0 };
    const coalescing = new CoalescingEngineDegradedEmitter(emitter, 60_000, () => nowRef.now);
    coalescing.emit("chatgpt");
    coalescing.emit("claude");
    expect(calls.sort()).toEqual(["chatgpt", "claude"]);
  });
});
