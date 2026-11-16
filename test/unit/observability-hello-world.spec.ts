import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REDACTED } from "../../src/lib/crypto/redact.js";
import { RedactingLogger } from "../../src/lib/logging/redacting-logger.js";
import { incrementCounter } from "../../src/lib/telemetry/metrics.js";
import { initTracing, registerRequestTracing, shutdownTracing } from "../../src/lib/telemetry/tracing.js";

// STORY-005 AC9 / scenario 1 - a hello-world request produces ONE trace correlated to the returned identifier, ONE metric
// and ONE log line with a redacted field. The route is defined here, on a bare Fastify instance carrying the production
// tracing hook (registerRequestTracing) and the production logger transport (RedactingLogger): the assembly the three
// signals share, without a database or a queue.
const SECRET_VALUE = "hunter2-do-not-log";
const HIGH_ENTROPY = "q8Zk2Vn9Xp4Lr7Tc1Wm6Yb3Hd5Jf0GsA";

describe("STORY-005 AC9 - hello world: a trace, a metric and a redacted log line from one request", () => {
  const stdout: string[] = [];
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let handlerSpan: ReadableSpan | undefined;

  beforeAll(() => {
    initTracing({});
    Logger.overrideLogger(new RedactingLogger());
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (stdout.push(String(chunk)), true));
  });
  afterAll(async () => {
    writeSpy.mockRestore();
    Logger.overrideLogger(true);
    await shutdownTracing();
  });

  it("the response identifier is the trace id of a recorded server span; the metric is emitted; the log field is redacted", async () => {
    const app = Fastify();
    registerRequestTracing(app);
    app.get("/hello", () => {
      handlerSpan = trace.getActiveSpan() as unknown as ReadableSpan;
      incrementCounter("nominara_observability_hello_total", { outcome: "ok" });
      new Logger("hello").log({ event: "hello", client_secret: SECRET_VALUE, note: HIGH_ENTROPY });
      return { hello: "world" };
    });
    const response = await app.inject({ method: "GET", url: "/hello" });
    await app.close();

    // Trace: the identifier on the wire is the span's trace id, and the span is a finished server span for this route.
    const requestId = response.headers["x-request-id"];
    expect(requestId).toMatch(/^[0-9a-f]{32}$/u);
    expect(handlerSpan?.spanContext().traceId).toBe(requestId);
    expect(handlerSpan?.ended).toBe(true);
    expect(handlerSpan?.attributes["http.route"]).toBe("/hello");
    expect(handlerSpan?.attributes["http.response.status_code"]).toBe(200);

    // Nest prints an object message as a multi-line block, so the signals are counted in the whole output (colours stripped).
    // eslint-disable-next-line no-control-regex
    const output = stdout.join("").replace(/\u001b\[[0-9;]*m/gu, "");
    const occurrences = (needle: string): number => output.split(needle).length - 1;
    // Metric: exactly one line for the hello-world counter, with its label.
    expect(occurrences("nominara_observability_hello_total")).toBe(1);
    expect(output).toContain("outcome: 'ok'");
    // Log: the line is present once; the secret-named field and the high-entropy value are not.
    expect(occurrences("event: 'hello'")).toBe(1);
    expect(output).not.toContain(SECRET_VALUE);
    expect(output).not.toContain(HIGH_ENTROPY);
    expect(output).toContain(`client_secret: '${REDACTED}'`);
  });
});
