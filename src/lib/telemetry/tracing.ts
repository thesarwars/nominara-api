import { randomBytes } from "node:crypto";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, trace, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { loadEnv } from "../../config/env.js";
import { incrementCounter } from "./metrics.js";

// STORY-024 AC9 — "the request identifier IS the trace identifier".
//
// Every request starts a FRESH trace (owner decision 2026-10-13 #2): an inbound
// `traceparent` is never extracted and an inbound `X-Request-Id` never becomes
// identity — either would let a caller choose the id a support ticket quotes,
// and collide two customers' tickets onto one trace. A caller's `X-Request-Id`
// is kept as a span attribute only. The 32-hex trace id is `meta.request_id`
// (envelope and Problem Details), the `x-request-id` response header, and the
// `request_id` on the request log lines.
//
// The SDK (sdk-trace-base) is always on, so ids exist with no collector. The
// OTLP exporter is wired only when OTEL_EXPORTER_OTLP_ENDPOINT is set.

const TRACER_NAME = "nominara-api";
const INBOUND_REQUEST_ID_ATTRIBUTE = "nominara.inbound_request_id";
// A caller-supplied value is untrusted; bound what a span can be made to carry.
const INBOUND_REQUEST_ID_MAX_LENGTH = 128;

export interface TracingEnv {
  OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
  OTEL_TRACES_SAMPLER_ARG?: number | undefined;
}

/** The exporter pipeline: empty unless a collector endpoint is configured. */
export function buildSpanProcessors(env: Pick<TracingEnv, "OTEL_EXPORTER_OTLP_ENDPOINT">): SpanProcessor[] {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined || endpoint === "") return [];
  const url = `${endpoint.replace(/\/+$/, "")}/v1/traces`;
  return [new BatchSpanProcessor(new OTLPTraceExporter({ url }))];
}

let provider: BasicTracerProvider | undefined;

/**
 * Idempotent: the OTel globals can be set once per process, and every app
 * assembly site (bootstrap and ~a dozen test apps) goes through configureApp().
 */
export function initTracing(env: TracingEnv = loadEnv()): void {
  if (provider !== undefined) return;
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  provider = new BasicTracerProvider({
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(env.OTEL_TRACES_SAMPLER_ARG ?? 1) }),
    spanProcessors: buildSpanProcessors(env),
  });
  trace.setGlobalTracerProvider(provider);
}

/** Flush and stop the exporter pipeline (process shutdown). */
export async function shutdownTracing(): Promise<void> {
  const current = provider;
  provider = undefined;
  if (current !== undefined) await current.shutdown();
}

const spans = new WeakMap<object, Span>();

/** A trace id for code that runs outside a request span (a unit test calling an interceptor directly). */
function detachedTraceId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The request identifier for a request: its server span's trace id. Falls back
 * to the active span, then to a fresh 32-hex id so the wire invariant (32
 * lowercase hex) holds even where no request span was started.
 */
export function requestIdOf(request: object | undefined): string {
  const span = (request === undefined ? undefined : spans.get(request)) ?? trace.getActiveSpan();
  return span?.spanContext().traceId ?? detachedTraceId();
}

function inboundRequestId(request: FastifyRequest): string | undefined {
  const supplied = request.headers?.["x-request-id"];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  return typeof value === "string" && value.length > 0 ? value.slice(0, INBOUND_REQUEST_ID_MAX_LENGTH) : undefined;
}

/**
 * Starts the per-request server span and makes it the ACTIVE span for the rest
 * of the request. Hooks (not an interceptor) because guards and the exception
 * filter run outside interceptors and a refused request still needs its id.
 */
export function registerRequestTracing(fastify: FastifyInstance): void {
  const tracer = trace.getTracer(TRACER_NAME);

  fastify.addHook("onRequest", (request, reply, done) => {
    const inbound = inboundRequestId(request);
    // ROOT_CONTEXT, and no propagator extract: a fresh trace, whatever the caller sent.
    const span = tracer.startSpan(
      `${request.method} ${request.url.split("?")[0] ?? ""}`.slice(0, 200),
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": request.method,
          ...(inbound !== undefined ? { [INBOUND_REQUEST_ID_ATTRIBUTE]: inbound } : {}),
        },
      },
      ROOT_CONTEXT,
    );
    spans.set(request, span);
    incrementCounter("nominara_api_request_spans_total", { sampled: String(span.isRecording()) });
    reply.header("x-request-id", span.spanContext().traceId);
    context.with(trace.setSpan(ROOT_CONTEXT, span), done);
  });

  const finish = (request: FastifyRequest, status: number | undefined): void => {
    const span = spans.get(request);
    if (span === undefined) return;
    spans.delete(request);
    const route = request.routeOptions?.url;
    if (route !== undefined) {
      span.updateName(`${request.method} ${route}`);
      span.setAttribute("http.route", route);
    }
    if (status !== undefined) {
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  };

  fastify.addHook("onResponse", (request, reply, done) => {
    finish(request, reply.statusCode);
    done();
  });
  fastify.addHook("onRequestAbort", (request, done) => {
    finish(request, undefined);
    done();
  });
}
