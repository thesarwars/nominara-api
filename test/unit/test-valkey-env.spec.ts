import net from "node:net";
import { describe, expect, it } from "vitest";
import { connectTargetOf, installConnectTripwire } from "../support/connect-tripwire.js";
import {
  DEAD_VALKEY_URL,
  INERT_CACHE_REDIS_URL,
  INERT_QUEUE_REDIS_URL,
  TEST_CACHE_REDIS_URL_ENV,
  TEST_QUEUE_REDIS_URL_ENV,
  assertNotADeveloperService,
  isDeveloperServiceTarget,
  testCacheRedisUrl,
  testQueueRedisUrl,
} from "../support/test-valkey.js";

// STORY-174 AC1/AC3/AC5 — the harness contract, as seen from a unit spec
// (no container: the setup file exports INERT URLs). The connection variables
// are checked for ABSENCE FIRST, before anything in this file touches env.

const ambientQueueUrl = process.env.QUEUE_REDIS_URL;
const ambientCacheUrl = process.env.VALKEY_CACHE_URL;

describe("STORY-174 AC3 · a spec can never inherit a developer's connection variables", () => {
  it("AC3 · QUEUE_REDIS_URL and VALKEY_CACHE_URL are unset at the start of every file (the shell's values are scrubbed)", () => {
    expect(ambientQueueUrl).toBeUndefined();
    expect(ambientCacheUrl).toBeUndefined();
  });

  it("AC3 · a helper with its variable unset throws instead of falling back to an address", () => {
    const saved = process.env[TEST_QUEUE_REDIS_URL_ENV];
    delete process.env[TEST_QUEUE_REDIS_URL_ENV];
    try {
      expect(() => testQueueRedisUrl()).toThrow(new RegExp(TEST_QUEUE_REDIS_URL_ENV));
    } finally {
      process.env[TEST_QUEUE_REDIS_URL_ENV] = saved as string;
    }
  });

  it("AC3 · a harness variable that names a developer's service is refused, for every developer port and loopback spelling", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "127.1.2.3"]) {
      for (const port of ["6379", "6380", "56379"]) {
        const saved = process.env[TEST_CACHE_REDIS_URL_ENV];
        process.env[TEST_CACHE_REDIS_URL_ENV] = `redis://${host}:${port}`;
        try {
          expect(() => testCacheRedisUrl(), `${host}:${port}`).toThrow(/developer service port/);
        } finally {
          process.env[TEST_CACHE_REDIS_URL_ENV] = saved as string;
        }
      }
    }
    expect(() => assertNotADeveloperService("X", "redis://localhost")).toThrow(/developer service port/); // no port = default 6379
  });
});

describe("STORY-174 AC1 · unit specs get an inert URL that parses and reaches nothing", () => {
  it("AC1 · without harness containers both helpers return the reserved .invalid hosts", () => {
    expect(testQueueRedisUrl()).toBe(INERT_QUEUE_REDIS_URL);
    expect(testCacheRedisUrl()).toBe(INERT_CACHE_REDIS_URL);
    for (const url of [INERT_QUEUE_REDIS_URL, INERT_CACHE_REDIS_URL]) {
      expect(URL.canParse(url)).toBe(true);
      expect(new URL(url).hostname.endsWith(".invalid")).toBe(true);
    }
  });

  it("AC1 · the queue and cache URLs are different instances", () => {
    expect(testQueueRedisUrl()).not.toBe(testCacheRedisUrl());
  });

  it("AC1 · the dead-address URL is loopback port 1, which no service listens on", () => {
    expect(new URL(DEAD_VALKEY_URL).port).toBe("1");
  });
});

describe("STORY-174 AC5 · the runtime tripwire refuses a developer-service dial", () => {
  it("AC5 · the target predicate covers every developer port on every loopback spelling, and nothing else", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "0.0.0.0", "LOCALHOST", "127.9.9.9", "db.localhost"]) {
      for (const port of [6379, 6380, 56379]) expect(isDeveloperServiceTarget(host, port), `${host}:${String(port)}`).toBe(true);
      expect(isDeveloperServiceTarget(host, 5432), `${host}:5432`).toBe(false);
    }
    expect(isDeveloperServiceTarget("cache.example.com", 6379)).toBe(false); // remote: the static guard's job
  });

  it("AC5 · connectTargetOf reads every shape Node's Socket.connect accepts", () => {
    expect(connectTargetOf([{ port: 6380, host: "127.0.0.1" }])).toEqual({ host: "127.0.0.1", port: 6380 });
    expect(connectTargetOf([{ port: 6380 }])).toEqual({ host: "localhost", port: 6380 });
    expect(connectTargetOf([6380, "localhost"])).toEqual({ host: "localhost", port: 6380 });
    expect(connectTargetOf([6380])).toEqual({ host: "localhost", port: 6380 });
    expect(connectTargetOf(["6380", "127.0.0.1"])).toEqual({ host: "127.0.0.1", port: 6380 });
    expect(connectTargetOf([[{ port: 6380, host: "localhost" }, () => undefined]])).toEqual({ host: "localhost", port: 6380 });
    expect(connectTargetOf([{ path: "/var/run/docker.sock" }])).toBeUndefined();
    expect(connectTargetOf(["/var/run/docker.sock"])).toBeUndefined();
  });

  it("AC5 · a forbidden dial is destroyed, recorded and NEVER forwarded; an allowed dial is forwarded untouched", async () => {
    // A fake socket prototype: proving the tripwire must not dial the ports it protects.
    const forwarded: unknown[][] = [];
    const destroyed: Error[] = [];
    const proto = {
      connect(this: unknown, ...args: unknown[]): unknown {
        forwarded.push(args);
        return this;
      },
      destroy(err: Error): void {
        destroyed.push(err);
      },
    };
    const recorded: string[] = [];
    const restore = installConnectTripwire(proto, (t) => isDeveloperServiceTarget(t.host, t.port), (m) => recorded.push(m));
    try {
      for (const [port, host] of [[6379, "localhost"], [6380, "127.0.0.1"], [56379, "::1"]] as const) {
        const result = (proto.connect as (...a: unknown[]) => unknown).call(proto, { port, host });
        expect(result).toBe(proto);
      }
      await new Promise((r) => process.nextTick(r));
      expect(forwarded).toEqual([]);
      expect(recorded).toHaveLength(3);
      expect(destroyed).toHaveLength(3);
      expect(destroyed[0]?.message).toMatch(/STORY-174/);

      (proto.connect as (...a: unknown[]) => unknown).call(proto, { port: 5432, host: "127.0.0.1" });
      (proto.connect as (...a: unknown[]) => unknown).call(proto, { path: "/x.sock" });
      expect(forwarded).toHaveLength(2);
    } finally {
      restore();
    }
    (proto.connect as (...a: unknown[]) => unknown).call(proto, { port: 6380, host: "localhost" });
    expect(forwarded).toHaveLength(3); // restored: original behaviour again
  });

  it("AC5 · the tripwire is actually installed on the real net.Socket in this worker", () => {
    expect(net.Socket.prototype.connect.name).toBe("patchedConnect");
  });
});
