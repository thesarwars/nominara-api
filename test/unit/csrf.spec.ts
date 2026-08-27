import { describe, expect, it } from "vitest";
import {
  computeCsrfToken,
  isMutatingMethod,
  requiresCsrfProtection,
  verifyDoubleSubmit,
} from "../../src/lib/auth/csrf.js";

const SID = "0192f1a0-0000-7000-8000-000000000001";
const SECRET = "test-csrf-secret";

describe("STORY-017 · csrf double-submit", () => {
  it("computeCsrfToken is a deterministic HMAC-SHA256 of the sid, recomputable without extra storage", () => {
    const first = computeCsrfToken(SID, SECRET);
    const second = computeCsrfToken(SID, SECRET);
    expect(first).toBe(second);
    expect(computeCsrfToken("some-other-sid", SECRET)).not.toBe(first);
  });

  // STORY-026 — a WebSocket handshake is not "mutating" in the HTTP sense and
  // IS CSRF-relevant, which is why these are two questions rather than one.
  // While they were one, verifyDoubleSubmit short-circuited on "WS" and the
  // handshake was the only cookie-authenticated transport with no CSRF check.
  it("requiresCsrfProtection covers the WebSocket handshake, which isMutatingMethod does not", () => {
    expect(isMutatingMethod("WS")).toBe(false);
    expect(requiresCsrfProtection("WS")).toBe(true);
    expect(requiresCsrfProtection("ws")).toBe(true);
    expect(requiresCsrfProtection("POST")).toBe(true);
    expect(requiresCsrfProtection("GET")).toBe(false);
  });

  it("isMutatingMethod is true for POST/PUT/PATCH/DELETE and false for GET/HEAD/OPTIONS", () => {
    expect(isMutatingMethod("POST")).toBe(true);
    expect(isMutatingMethod("put")).toBe(true);
    expect(isMutatingMethod("PATCH")).toBe(true);
    expect(isMutatingMethod("DELETE")).toBe(true);
    expect(isMutatingMethod("GET")).toBe(false);
    expect(isMutatingMethod("HEAD")).toBe(false);
    expect(isMutatingMethod("OPTIONS")).toBe(false);
  });

  it("STORY-017 · scenario 6 — a session-authenticated mutating request with no double-submit token is refused", () => {
    const permitted = verifyDoubleSubmit({
      authMethod: "session",
      method: "POST",
      sid: SID,
      cookieToken: undefined,
      headerToken: undefined,
      secret: SECRET,
    });
    expect(permitted).toBe(false);
  });

  it("a session-authenticated mutating request with a matching cookie/header pair is permitted", () => {
    const token = computeCsrfToken(SID, SECRET);
    const permitted = verifyDoubleSubmit({
      authMethod: "session",
      method: "POST",
      sid: SID,
      cookieToken: token,
      headerToken: token,
      secret: SECRET,
    });
    expect(permitted).toBe(true);
  });

  it("a session-authenticated mutating request with a mismatched header is refused", () => {
    const cookieToken = computeCsrfToken(SID, SECRET);
    const permitted = verifyDoubleSubmit({
      authMethod: "session",
      method: "POST",
      sid: SID,
      cookieToken,
      headerToken: computeCsrfToken("a-different-sid", SECRET),
      secret: SECRET,
    });
    expect(permitted).toBe(false);
  });

  it("a session-authenticated non-mutating (GET) request needs no double-submit token", () => {
    const permitted = verifyDoubleSubmit({
      authMethod: "session",
      method: "GET",
      sid: SID,
      cookieToken: undefined,
      headerToken: undefined,
      secret: SECRET,
    });
    expect(permitted).toBe(true);
  });

  it("STORY-017 · scenario 7 — a mutating request authenticated by an API key (header-only, cookie-less) needs no double-submit token", () => {
    const permitted = verifyDoubleSubmit({
      authMethod: "apiKey",
      method: "POST",
      sid: SID,
      cookieToken: undefined,
      headerToken: undefined,
      secret: SECRET,
    });
    expect(permitted).toBe(true);
  });
});
