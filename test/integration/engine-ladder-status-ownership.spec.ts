import { Client, Pool } from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import type { EngineKey } from "../../src/lib/engines/contract.js";
import { DEGRADATION_STAGE_5_OPEN_DURATION_MS } from "../../src/lib/engines/degradation.js";
import { DegradationRuntime } from "../../src/lib/engines/degradation-runtime.js";
import type { EngineBreakerDetail } from "../../src/lib/engines/engine-breaker.js";
import { EngineStatusService } from "../../src/modules/health/engine-status.service.js";

// REVIEW FIX (stream A-engines, round 1) - `engines.status` is OPERATOR state (migration 0027: "an incident responder sets
// 'degraded' when a vendor is down. Re-seeding it back to 'active' resumes scheduling against a broken vendor, silently"). The
// ladder evaluator may only move what it owns:
//   - stage 5 moves an ACTIVE engine to `degraded`, never a `disabled` or `beta` one (the canary probes every registry engine
//     whatever its DB status, so a disabled engine's breaker CAN open);
//   - recovery moves back to `active` only a `degraded` the ladder itself wrote and nobody has touched since; an operator's
//     `degraded` survives every tick.
// Driven against the REAL `engines` table (and its touch_updated_at trigger) through the real EngineStatusService; the breakers are
// the only fake, so each tick's breaker state is chosen by the test.

const NOW = 60_000_000_000;
const closed: EngineBreakerDetail = { state: "closed", openedAt: null, since: null, reason: null };
const longOpen: EngineBreakerDetail = { state: "open", openedAt: NOW - 1_000, since: NOW - DEGRADATION_STAGE_5_OPEN_DURATION_MS - 60_000, reason: "ratio" };

/** In-memory stand-in for the ladder's ownership marks (the Valkey store has its own test). */
class MemoryMarks {
  readonly marks = new Map<string, string>();
  failReads = false;
  read(engineKey: EngineKey): Promise<string | null> {
    if (this.failReads) return Promise.reject(new Error("cache down"));
    return Promise.resolve(this.marks.get(engineKey) ?? null);
  }
  write(engineKey: EngineKey, stamp: string): Promise<void> {
    this.marks.set(engineKey, stamp);
    return Promise.resolve();
  }
  clear(engineKey: EngineKey): Promise<void> {
    this.marks.delete(engineKey);
    return Promise.resolve();
  }
}

describe("STORY-031 AC7 · the ladder never overwrites operator-owned engines.status", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let marks: MemoryMarks;
  let breaker: Partial<Record<EngineKey, EngineBreakerDetail>>;
  let ladder: DegradationRuntime;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client);
    await client.end();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM engines");
    marks = new MemoryMarks();
    breaker = {};
    ladder = new DegradationRuntime({
      engines: ["gemini", "chatgpt", "claude"],
      breakers: { for: (key) => ({ detail: () => Promise.resolve(breaker[key as EngineKey] ?? closed), blockRatio: () => Promise.resolve(0) }) },
      status: new EngineStatusService(pool, marks),
      shaping: { onRatioObserved: () => Promise.resolve() },
      clock: () => NOW,
    });
  });

  async function seed(key: EngineKey, status: string): Promise<void> {
    await pool.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ($1, $1, 'vendor', 'api', 'v1', 3600, 'medium', 'free', $2)`,
      [key, status],
    );
  }

  async function status(key: EngineKey): Promise<string> {
    return (await pool.query<{ status: string }>("SELECT status FROM engines WHERE key = $1", [key])).rows[0]!.status;
  }

  it("a disabled engine and a beta engine stay as they are through an open-past-30-minutes tick and then a closed tick", async () => {
    await seed("gemini", "disabled");
    await seed("chatgpt", "beta");
    breaker = { gemini: longOpen, chatgpt: longOpen };
    await ladder.tick();
    expect(await status("gemini")).toBe("disabled");
    expect(await status("chatgpt")).toBe("beta");
    breaker = {};
    await ladder.tick();
    expect(await status("gemini")).toBe("disabled");
    expect(await status("chatgpt")).toBe("beta");
  });

  it("an operator's `degraded` survives a tick with the breaker closed", async () => {
    await seed("gemini", "degraded");
    await ladder.tick();
    expect(await status("gemini")).toBe("degraded");
  });

  it("the ladder's own `degraded` goes back to `active` once the breaker closes (control)", async () => {
    await seed("claude", "active");
    breaker = { claude: longOpen };
    await ladder.tick();
    expect(await status("claude")).toBe("degraded");
    breaker = {};
    await ladder.tick();
    expect(await status("claude")).toBe("active");
  });

  it("an operator who disables a ladder-degraded engine keeps it disabled after the breaker closes", async () => {
    await seed("claude", "active");
    breaker = { claude: longOpen };
    await ladder.tick();
    await pool.query("UPDATE engines SET status = 'disabled' WHERE key = 'claude'");
    breaker = {};
    await ladder.tick();
    expect(await status("claude")).toBe("disabled");
  });

  it("an operator who re-asserts `degraded` on a ladder-degraded engine takes ownership: the closed breaker leaves it degraded", async () => {
    await seed("claude", "active");
    breaker = { claude: longOpen };
    await ladder.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await pool.query("UPDATE engines SET status = 'degraded' WHERE key = 'claude'");
    breaker = {};
    await ladder.tick();
    expect(await status("claude")).toBe("degraded");
  });

  it("an unreadable ownership mark leaves a degraded engine degraded (never guesses it was the ladder's)", async () => {
    await seed("claude", "active");
    breaker = { claude: longOpen };
    await ladder.tick();
    marks.failReads = true;
    breaker = {};
    await ladder.tick();
    expect(await status("claude")).toBe("degraded");
  });
});
