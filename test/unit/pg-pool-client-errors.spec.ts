import { EventEmitter } from "node:events";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPgPool } from "../../src/db/pg-pool.js";

// Checkpoint-6 (blocker). pg-pool removes its own `error` listener from a client when it is checked out, so a
// connection that the pooler closes while a request holds it emits `error` on an object nothing listens to, and
// Node exits. Every pool `createPgPool` builds (main, settlement, portal, worker, write) must leave a listener on
// every client it creates, and one on the pool itself.

const NOWHERE = "postgres://nobody:s3cret-pw@127.0.0.1:1/nothing";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkpoint-6 · createPgPool leaves an error listener on every client it creates", () => {
  it("D-1 AC-client-listener . a client announced by the pool's `connect` event survives an `error` event, which is counted and logged without its text", () => {
    const logged: unknown[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => void logged.push(message));
    vi.spyOn(Logger.prototype, "error").mockImplementation((message: unknown) => void logged.push(message));
    const pool = createPgPool(NOWHERE);
    const client = new EventEmitter();
    pool.emit("connect", client);

    expect(() => client.emit("error", new Error("Connection terminated unexpectedly postgres://nobody:s3cret-pw@host/db"))).not.toThrow();
    expect(logged).toContainEqual(expect.objectContaining({ metric: "nominara_db_client_error_total" }));
    expect(JSON.stringify(logged)).not.toContain("s3cret-pw");
    expect(JSON.stringify(logged)).not.toContain("Connection terminated");
  });

  it("D-1 AC-pool-listener . an `error` event on the pool itself does not throw", () => {
    const pool = createPgPool(NOWHERE);
    expect(() => pool.emit("error", new Error("idle client failed"))).not.toThrow();
  });
});
