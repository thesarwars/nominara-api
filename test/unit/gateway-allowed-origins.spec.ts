import { describe, expect, it } from "vitest";
import { MissingAllowedOriginsError, parseAllowedOrigins } from "../../src/gateway/allowed-origins.js";

// STORY-026 — the socket handshake's Origin allow-list, and specifically the
// decision NOT to give it a permissive default.
//
// This is asserted here rather than through RealtimeModule because the
// provider runs inside NestFactory.create, which ABORTS THE PROCESS on a
// provider error (`abortOnError` defaults to true) — a spec driving it that
// way takes the test worker down with it, so the guard would end up untested
// precisely because it works.
describe("STORY-026 · REALTIME_ALLOWED_ORIGINS", () => {
  it("splits a comma-separated list and trims each entry", () => {
    expect(parseAllowedOrigins("https://app.test, https://admin.test")).toEqual([
      "https://app.test",
      "https://admin.test",
    ]);
  });

  // An empty allow-list would be a check that permits everything — the exact
  // shape of defect this story exists to remove. A gateway that will not start
  // is loud; one that admits a hostile same-site subdomain is silent.
  it.each([undefined, "", "   ", ",", " , , "])("refuses %p rather than allowing everything", (raw) => {
    expect(() => parseAllowedOrigins(raw)).toThrow(MissingAllowedOriginsError);
  });

  it("names the key in the error, so the failure says what to set", () => {
    expect(() => parseAllowedOrigins(undefined)).toThrow(/REALTIME_ALLOWED_ORIGINS/);
  });
});
