import { afterEach, describe, expect, it } from "vitest";
import { KNOWN_KEYS } from "../../src/config/env.js";
import { envSchema } from "../../src/config/env.schema.js";
import { buildSpanProcessors } from "../../src/lib/telemetry/tracing.js";

// STORY-024 decision 3 — the exporter is OFF unless OTEL_EXPORTER_OTLP_ENDPOINT
// is set, so ids exist everywhere but no process opens a connection to a
// collector by accident, and no test needs one.
describe("STORY-024 · tracing exporter wiring", () => {
  const shutdowns: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(shutdowns.splice(0).map((fn) => fn()));
  });

  it("[STORY-024 decision 3] no exporter without OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    expect(buildSpanProcessors({})).toEqual([]);
    expect(buildSpanProcessors({ OTEL_EXPORTER_OTLP_ENDPOINT: undefined })).toEqual([]);
  });

  it("[STORY-024 decision 3] an exporter pipeline exists when the endpoint is set", () => {
    const processors = buildSpanProcessors({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid:4318" });
    shutdowns.push(...processors.map((p) => () => p.shutdown()));
    expect(processors).toHaveLength(1);
  });

  it("[STORY-024 decision 3] the new keys are known to the env loader and validated", () => {
    expect(KNOWN_KEYS).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(KNOWN_KEYS).toContain("OTEL_TRACES_SAMPLER_ARG");
    const shape = envSchema.shape;
    expect(shape).toHaveProperty("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(shape).toHaveProperty("OTEL_TRACES_SAMPLER_ARG");
  });

  it("[STORY-024 decision 3] the sampling ratio is bounded to [0, 1]", () => {
    const ratio = envSchema.shape.OTEL_TRACES_SAMPLER_ARG;
    expect(ratio.safeParse("0").success).toBe(true);
    expect(ratio.safeParse("0.25").success).toBe(true);
    expect(ratio.safeParse("1").success).toBe(true);
    expect(ratio.safeParse("1.5").success).toBe(false);
    expect(ratio.safeParse("-0.1").success).toBe(false);
    expect(ratio.safeParse("abc").success).toBe(false);
  });
});
