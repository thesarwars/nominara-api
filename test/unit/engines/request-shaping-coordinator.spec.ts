import { describe, expect, it } from "vitest";
import { RequestShapingCoordinator, type BreachTrackerStore } from "../../../src/lib/engines/request-shaping-coordinator.js";
import type { RequestShapingRotator } from "../../../src/lib/engines/ports.js";

// STORY-031 Phase G stage 3 — EC-06: "blocks/attempts > 0.10 → rotate the
// request-shaping profile". "Once per breach" mirrors DlqDepthMonitor's own
// "pages exactly once per sustained breach... a later breach pages again"
// shape (src/lib/queue/dead-letter.ts) — a SUSTAINED breach rotates once;
// dropping back below the threshold and breaching again rotates again.

class InMemoryBreachTrackerStore implements BreachTrackerStore {
  private readonly inBreach = new Map<string, boolean>();
  async read(engineKey: string): Promise<boolean> {
    return this.inBreach.get(engineKey) ?? false;
  }
  async write(engineKey: string, value: boolean): Promise<void> {
    this.inBreach.set(engineKey, value);
  }
}

function fakeRotator() {
  const calls: string[] = [];
  const rotator: RequestShapingRotator = { rotate: (engineKey) => calls.push(engineKey) };
  return { rotator, calls };
}

describe("STORY-031 · RequestShapingCoordinator — rotates the shaping profile at most once per sustained breach", () => {
  it("a ratio at or below 0.10 never rotates", async () => {
    const { rotator, calls } = fakeRotator();
    const coordinator = new RequestShapingCoordinator(rotator, new InMemoryBreachTrackerStore());
    await coordinator.onRatioObserved("chatgpt", 0.10);
    await coordinator.onRatioObserved("chatgpt", 0.05);
    expect(calls).toHaveLength(0);
  });

  it("crossing above 0.10 rotates exactly once, even across many subsequent still-breaching observations", async () => {
    const { rotator, calls } = fakeRotator();
    const coordinator = new RequestShapingCoordinator(rotator, new InMemoryBreachTrackerStore());
    await coordinator.onRatioObserved("chatgpt", 0.15);
    await coordinator.onRatioObserved("chatgpt", 0.20);
    await coordinator.onRatioObserved("chatgpt", 0.30);
    expect(calls).toEqual(["chatgpt"]);
  });

  it("dropping back to <=0.10 clears the breach state, so a LATER breach rotates again", async () => {
    const { rotator, calls } = fakeRotator();
    const coordinator = new RequestShapingCoordinator(rotator, new InMemoryBreachTrackerStore());
    await coordinator.onRatioObserved("chatgpt", 0.15); // breach 1 — rotates
    await coordinator.onRatioObserved("chatgpt", 0.05); // recovers
    await coordinator.onRatioObserved("chatgpt", 0.20); // breach 2 — rotates again
    expect(calls).toEqual(["chatgpt", "chatgpt"]);
  });

  it("each engine's breach state is independent — one engine's rotation never affects another's", async () => {
    const { rotator, calls } = fakeRotator();
    const coordinator = new RequestShapingCoordinator(rotator, new InMemoryBreachTrackerStore());
    await coordinator.onRatioObserved("chatgpt", 0.20);
    await coordinator.onRatioObserved("claude", 0.20);
    expect(calls.sort()).toEqual(["chatgpt", "claude"]);
  });
});

describe("STORY-031 Phase J · RequestShapingCoordinator — D19's spirit extended: a store failure never throws", () => {
  class FailingStore implements BreachTrackerStore {
    async read(): Promise<boolean> {
      throw new Error("cache instance unreachable");
    }
    async write(): Promise<void> {
      throw new Error("cache instance unreachable");
    }
  }

  it("onRatioObserved never throws when the store is entirely unreachable", async () => {
    const { rotator } = fakeRotator();
    const coordinator = new RequestShapingCoordinator(rotator, new FailingStore());
    await expect(coordinator.onRatioObserved("chatgpt", 0.5)).resolves.toBeUndefined();
  });
});
