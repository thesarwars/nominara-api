import { afterEach, describe, expect, it, vi } from "vitest";
import { RedactingLogger, redactLogArgument } from "./redacting-logger.js";
import { REDACTED } from "../crypto/redact.js";

// STORY-005 AC2 - every log line goes through redact.ts's deny-list AND entropy detector, in the logger transport,
// not only in the audit chain. Scenario 2 (secret-named field) and scenario 3 (high-entropy value under an innocent key).
const UUID = "0192f3c4-7a1b-7c2d-8e3f-4a5b6c7d8e9f";
const HIGH_ENTROPY = "q8Zk2Vn9Xp4Lr7Tc1Wm6Yb3Hd5Jf0GsA";

function capture(emit: (logger: RedactingLogger) => void): string {
  const chunks: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    emit(new RedactingLogger("test"));
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return chunks.join("");
}

afterEach(() => vi.restoreAllMocks());

describe("STORY-005 AC2 - the logger transport redacts", () => {
  it("scenario 2: a field named like a secret is redacted in the transport output", () => {
    const output = capture((logger) => logger.log({ event: "login", password: "hunter2", api_key: "short" }));
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("short");
    expect(output).toContain(REDACTED);
    expect(output).toContain("login");
  });

  it("scenario 3: a high-entropy string under a field NOT on the deny-list is redacted by the detector", () => {
    const output = capture((logger) => logger.log({ note: HIGH_ENTROPY, nested: { deep: [HIGH_ENTROPY] } }));
    expect(output).not.toContain(HIGH_ENTROPY);
  });

  it("a secret embedded in a plain-string message is redacted, the rest of the line is kept", () => {
    const output = capture((logger) => logger.warn(`upstream said key ${HIGH_ENTROPY} rejected for workspace_id=${UUID}`));
    expect(output).not.toContain(HIGH_ENTROPY);
    expect(output).toContain(`workspace_id=${UUID}`);
    expect(output).toContain("rejected");
  });

  it("key=value pairs with a deny-listed key are redacted in a string message", () => {
    const output = capture((logger) => logger.log("connect password=hunter2 host=db"));
    expect(output).not.toContain("hunter2");
    expect(output).toContain("host=db");
  });

  it("a Bearer credential and a URL with embedded credentials are redacted", () => {
    const output = capture((logger) => logger.error("call failed Authorization: Bearer abc.def.ghi at postgres://app:s3cretpw@db:5432/x"));
    expect(output).not.toContain("abc.def.ghi");
    expect(output).not.toContain("s3cretpw");
  });

  it("the stack argument and the context survive; only secrets inside the stack are removed", () => {
    const stack = `Error: boom\n    at Foo.bar (/app/src/modules/foo/foo.service.ts:123:45)\n    at async Promise.all (index 0)`;
    const output = capture((logger) => logger.error("failed", stack, "FooService"));
    expect(output).toContain("foo.service.ts:123:45");
    expect(output).toContain("FooService");
  });

  it("an Error message carrying a secret is redacted", () => {
    const output = capture((logger) => logger.error(new Error(`bad key ${HIGH_ENTROPY}`)));
    expect(output).not.toContain(HIGH_ENTROPY);
  });
});

describe("STORY-005 AC2 - redaction does not strip what tests and operators rely on", () => {
  it("workspace and entity ids (UUIDs) survive as values and under *_id keys", () => {
    const out = redactLogArgument({ workspace_id: UUID, share_token_id: UUID, ids: [UUID] }) as Record<string, unknown>;
    expect(out).toEqual({ workspace_id: UUID, share_token_id: UUID, ids: [UUID] });
  });

  it("numbers and booleans under a deny-listed key name are kept (tokens_in, token_count are counts, not secrets)", () => {
    const out = redactLogArgument({ tokens_in: 120, token_count: 0, has_password: false }) as Record<string, unknown>;
    expect(out).toEqual({ tokens_in: 120, token_count: 0, has_password: false });
  });

  it("a metric line keeps its name, value and labels", () => {
    const line = { metric: "nominara_billing_addon_change_total", value: 1, outcome: "applied", plan: "growth" };
    expect(redactLogArgument(line)).toEqual(line);
  });

  it("null and 0 stay distinguished", () => {
    expect(redactLogArgument({ a: null, b: 0, c: undefined })).toEqual({ a: null, b: 0, c: undefined });
  });

  it("a string under a deny-listed key is redacted even when it is a UUID, unless the key is an id key", () => {
    expect(redactLogArgument({ api_key: UUID })).toEqual({ api_key: REDACTED });
    expect(redactLogArgument({ share_token_id: UUID })).toEqual({ share_token_id: UUID });
  });

  it("does not mutate its input, and survives a cycle", () => {
    const input: Record<string, unknown> = { password: "x" };
    input.self = input;
    expect(() => redactLogArgument(input)).not.toThrow();
    expect(input.password).toBe("x");
  });

  it("hot path: a typical metric line is redacted in well under a millisecond on average", () => {
    const line = { metric: "nominara_api_idempotency_replay_total", value: 1, route: "POST /v1/projects", outcome: "replayed" };
    const start = performance.now();
    for (let i = 0; i < 20_000; i += 1) redactLogArgument(line);
    // A deliberately generous bound (20k lines in 2s = 100us each) - it catches an accidental O(n^2) or a per-line regex compile, not noise.
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

describe("STORY-005 AC2 - the identifier exemption is not a hole", () => {
  it("a lowercase-and-digits credential with separators is still redacted", () => {
    expect(redactLogArgument({ note: "sk_live_abcd1234efgh5678ijkl9012" })).toEqual({ note: REDACTED });
  });
  it("a long unbroken lowercase run is still redacted", () => {
    expect(redactLogArgument({ note: "qwzxkjvbnmpltrdgfhsyqwzxkjv" })).toEqual({ note: REDACTED });
  });
  it("snake_case and dotted event names survive", () => {
    expect(redactLogArgument({ action: "workspace.deletion_scheduled" })).toEqual({ action: "workspace.deletion_scheduled" });
  });
});

describe("STORY-005 AC2 - the transport is what Nest's Logger writes through", () => {
  it("Logger.overrideLogger(new RedactingLogger()) redacts a line logged by an ordinary `new Logger(ctx)`", async () => {
    const { Logger } = await import("@nestjs/common");
    const chunks: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (chunks.push(String(chunk)), true));
    try {
      Logger.overrideLogger(new RedactingLogger());
      new Logger("Svc").log({ client_secret: "x", workspace_id: UUID, note: HIGH_ENTROPY });
    } finally {
      out.mockRestore();
      Logger.overrideLogger(true);
    }
    const text = chunks.join("");
    expect(text).toContain(UUID);
    expect(text).not.toContain(HIGH_ENTROPY);
    expect(text).toContain(REDACTED);
  });

  it("main.ts, worker.ts and gateway.ts each construct their Nest app with the RedactingLogger", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["main.ts", "worker.ts", "gateway.ts"]) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      expect(source, file).toMatch(/logger: new RedactingLogger\(\)/u);
    }
  });
});
