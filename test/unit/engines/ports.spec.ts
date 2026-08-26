import { describe, expect, it, vi } from "vitest";
import * as metrics from "../../../src/lib/telemetry/metrics.js";
import { defaultCellRequeuePort, defaultEngineDegradedEmitter, defaultRequestShapingRotator } from "../../../src/lib/engines/ports.js";

// STORY-031 D14 — ports, not integrations (same posture as STORY-030's D10
// Pager port). No real backend exists for any of these yet: default = log +
// incrementCounter, never a thrown error, never a network call.

describe("STORY-031 · D14 default ports — log + incrementCounter, never throw", () => {
  it("defaultEngineDegradedEmitter emits without throwing and increments a counter", () => {
    const spy = vi.spyOn(metrics, "incrementCounter");
    expect(() => defaultEngineDegradedEmitter.emit("chatgpt")).not.toThrow();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("nominara_"), expect.objectContaining({ engine_key: "chatgpt" }));
    spy.mockRestore();
  });

  it("defaultRequestShapingRotator rotates without throwing and increments a counter", () => {
    const spy = vi.spyOn(metrics, "incrementCounter");
    expect(() => defaultRequestShapingRotator.rotate("claude")).not.toThrow();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("nominara_"), expect.objectContaining({ engine_key: "claude" }));
    spy.mockRestore();
  });

  it("defaultCellRequeuePort requeues without throwing and increments a counter", () => {
    const spy = vi.spyOn(metrics, "incrementCounter");
    expect(() => defaultCellRequeuePort.requeue("gemini", 20 * 60 * 1000)).not.toThrow();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("nominara_"), expect.objectContaining({ engine_key: "gemini" }));
    spy.mockRestore();
  });
});
