import { describe, expect, it } from "vitest";
import {
  ENGINE_BREAKER_OPEN_DURATION_MS,
  EngineBreaker,
  type EngineBreakerEpisode,
  type EngineBreakerEpisodeStore,
  type EngineBreakerRatioCounter,
  type EngineBreakerStateStore,
} from "../../../src/lib/engines/engine-breaker.js";

// STORY-031 AC6/AC7/AC8 — the breaker's EPISODE. EC-06 stage 5 is "circuit open > 30 min", and the breaker's own open window is
// 20 minutes, after which it half-opens and a failed probe re-opens it with a NEW `openedAt`. Measured from `openedAt`, the
// open duration would reset every 20 minutes and stage 5 could never fire. The episode's `since` is when the breaker LEFT
// closed, and only a successful half-open probe (closing it) ends the episode. `reason` is what the capture path branches on:
// a quota-opened breaker skips cells for the next window (EC-08), a ratio-opened one re-queues them (EC-06 stage 4).

class FakeStateStore implements EngineBreakerStateStore {
  value: number | null = null;
  async read(): Promise<number | null> {
    return this.value;
  }
  async write(_engineKey: string, openedAt: number | null): Promise<void> {
    this.value = openedAt;
  }
}

class FakeEpisodeStore implements EngineBreakerEpisodeStore {
  value: EngineBreakerEpisode | null = null;
  async read(): Promise<EngineBreakerEpisode | null> {
    return this.value;
  }
  async write(_engineKey: string, episode: EngineBreakerEpisode | null): Promise<void> {
    this.value = episode;
  }
}

class FakeRatioCounter implements EngineBreakerRatioCounter {
  attempts = 0;
  blocks = 0;
  async record(_engineKey: string, isBlocked: boolean): Promise<{ attempts: number; blocks: number }> {
    this.attempts += 1;
    if (isBlocked) this.blocks += 1;
    return { attempts: this.attempts, blocks: this.blocks };
  }
  async peek(): Promise<{ attempts: number; blocks: number }> {
    return { attempts: this.attempts, blocks: this.blocks };
  }
}

function make(now: { t: number }) {
  const state = new FakeStateStore();
  const episodes = new FakeEpisodeStore();
  const ratio = new FakeRatioCounter();
  const breaker = new EngineBreaker("gemini", state, ratio, () => now.t, episodes);
  return { breaker, state, episodes, ratio };
}

describe("STORY-031 AC8 · a quota-opened breaker says so", () => {
  it("quota_exhausted opens with reason 'quota' and since = the open instant", async () => {
    const now = { t: 1_000 };
    const { breaker } = make(now);
    await breaker.recordOutcome("quota_exhausted");
    expect(await breaker.detail()).toEqual({ state: "open", openedAt: 1_000, since: 1_000, reason: "quota" });
  });

  it("a block-ratio open has reason 'ratio'", async () => {
    const now = { t: 5_000 };
    const { breaker } = make(now);
    await breaker.recordOutcome("blocked");
    expect(await breaker.detail()).toMatchObject({ state: "open", since: 5_000, reason: "ratio" });
  });

  it("a closed breaker reports no episode", async () => {
    const { breaker } = make({ t: 0 });
    expect(await breaker.detail()).toEqual({ state: "closed", openedAt: null, since: null, reason: null });
  });
});

describe("STORY-031 AC6/AC7 · the episode survives a failed half-open probe, and ends only when the breaker closes", () => {
  it("a re-open from half_open keeps the episode's since and moves openedAt", async () => {
    const now = { t: 0 };
    const { breaker } = make(now);
    await breaker.recordOutcome("blocked");
    now.t = ENGINE_BREAKER_OPEN_DURATION_MS + 1;
    expect((await breaker.detail()).state).toBe("half_open");
    await breaker.recordOutcome("other_failure");
    expect(await breaker.detail()).toEqual({ state: "open", openedAt: ENGINE_BREAKER_OPEN_DURATION_MS + 1, since: 0, reason: "ratio" });
  });

  it("a successful half-open probe closes the breaker and clears the episode; the next open starts a new one", async () => {
    const now = { t: 0 };
    const { breaker, episodes } = make(now);
    await breaker.recordOutcome("quota_exhausted");
    now.t = ENGINE_BREAKER_OPEN_DURATION_MS + 1;
    await breaker.recordOutcome("success");
    expect(await breaker.detail()).toEqual({ state: "closed", openedAt: null, since: null, reason: null });
    expect(episodes.value).toBeNull();
  });

  it("an episode store that throws never fails the breaker: since falls back to openedAt", async () => {
    const now = { t: 7 };
    const state = new FakeStateStore();
    const broken: EngineBreakerEpisodeStore = { read: () => Promise.reject(new Error("down")), write: () => Promise.reject(new Error("down")) };
    const breaker = new EngineBreaker("gemini", state, new FakeRatioCounter(), () => now.t, broken);
    await expect(breaker.recordOutcome("quota_exhausted")).resolves.toMatchObject({ state: "open", retry: false });
    expect(await breaker.detail()).toEqual({ state: "open", openedAt: 7, since: 7, reason: null });
  });
});

describe("STORY-031 AC6 · blockRatio reads the window without counting an attempt", () => {
  it("returns blocks/attempts, and 0 (never NaN) with no attempts", async () => {
    const { breaker, ratio } = make({ t: 0 });
    expect(await breaker.blockRatio()).toBe(0);
    ratio.attempts = 10;
    ratio.blocks = 2;
    expect(await breaker.blockRatio()).toBeCloseTo(0.2, 9);
    expect(ratio.attempts).toBe(10);
  });
});
