import type { EngineKey } from "./contract.js";
import { defaultPager, type Pager } from "../queue/dead-letter.js";

// STORY-031 Phase G stage 6 — EC-06: "blackout > 48h → page on-call; rotate
// credentials or contact the vendor; customers see a status-page entry and
// a data-gap band on every chart." Reuses the EXISTING Pager port (D14,
// src/lib/queue/dead-letter.ts) rather than a new one. Same `observe()`
// shape as DlqDepthMonitor's own sustained-breach paging in that file.

/** EC-06's exact reference constant. */
export const BLACKOUT_THRESHOLD_MS = 48 * 60 * 60 * 1000;

/**
 * NOT a reference constant — EC-06 states only the 48h page trigger, never
 * a repeat-page cooldown. 24 hours is this story's own interpolation for
 * how long to wait before paging again on a STILL-dark engine, chosen so
 * on-call isn't re-paged more than once a day for the same ongoing outage.
 */
export const BLACKOUT_PAGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Serialisable monitor state (STORY-179): epoch-ms maps keyed by engine. */
export interface BlackoutMonitorState {
  readonly darkSinceMs: Readonly<Record<string, number>>;
  readonly lastPagedAtMs: Readonly<Record<string, number>>;
}

export class BlackoutMonitor {
  private readonly darkSinceMs = new Map<EngineKey, number>();
  private readonly lastPagedAtMs = new Map<EngineKey, number>();

  constructor(
    private readonly pager: Pager = defaultPager,
    private readonly clock: () => number = () => Date.now(),
    private readonly thresholdMs: number = BLACKOUT_THRESHOLD_MS,
    private readonly cooldownMs: number = BLACKOUT_PAGE_COOLDOWN_MS,
  ) {}

  /**
   * Call whenever an engine's outcome is known. `success` clears its
   * dark-since state entirely (a later failure starts counting from zero,
   * never inheriting stale dark-duration); anything else starts or
   * continues tracking how long it has been continuously dark.
   */
  observe(engineKey: EngineKey, success: boolean): void {
    const now = this.clock();

    if (success) {
      this.darkSinceMs.delete(engineKey);
      return;
    }

    const darkSince = this.darkSinceMs.get(engineKey);
    if (darkSince === undefined) {
      this.darkSinceMs.set(engineKey, now);
      return;
    }

    this.evaluate(engineKey, darkSince, now);
  }

  /**
   * STORY-179 — feed the monitor from the last recorded success (`engine_health`) rather than from a live stream of
   * outcomes. A success inside the window clears the dark clock; an older one starts it AT THAT SUCCESS, so the page
   * lands 48h after the engine last worked and not 48h after this process first looked. `null` means no success was
   * ever recorded, which is not "dark since the epoch": the clock starts at the first look, exactly as `observe(false)`.
   */
  observeLastSuccess(engineKey: EngineKey, lastSuccessAtMs: number | null): void {
    if (lastSuccessAtMs === null) {
      this.observe(engineKey, false);
      return;
    }
    const now = this.clock();
    if (now - lastSuccessAtMs <= this.thresholdMs) {
      this.darkSinceMs.delete(engineKey);
      return;
    }
    this.darkSinceMs.set(engineKey, lastSuccessAtMs);
    this.evaluate(engineKey, lastSuccessAtMs, now);
  }

  /** Plain data, so a different replica can carry on from where this one stopped (STORY-179). */
  exportState(): BlackoutMonitorState {
    return {
      darkSinceMs: Object.fromEntries(this.darkSinceMs),
      lastPagedAtMs: Object.fromEntries(this.lastPagedAtMs),
    };
  }

  importState(state: BlackoutMonitorState): void {
    this.darkSinceMs.clear();
    this.lastPagedAtMs.clear();
    for (const [key, at] of Object.entries(state.darkSinceMs)) this.darkSinceMs.set(key as EngineKey, at);
    for (const [key, at] of Object.entries(state.lastPagedAtMs)) this.lastPagedAtMs.set(key as EngineKey, at);
  }

  private evaluate(engineKey: EngineKey, darkSince: number, now: number): void {
    const darkDurationMs = now - darkSince;
    if (darkDurationMs <= this.thresholdMs) {
      return;
    }

    const lastPagedAt = this.lastPagedAtMs.get(engineKey);
    if (lastPagedAt !== undefined && now - lastPagedAt < this.cooldownMs) {
      return;
    }

    this.lastPagedAtMs.set(engineKey, now);
    this.pager.page(`engine '${engineKey}' has been dark (no successful capture) for over 48 hours`, {
      alertName: "engine_blackout",
      engineKey,
      darkDurationMs,
    });
  }
}
