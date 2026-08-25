import type { ExecutionContext } from "@nestjs/common";

// STORY-026 T21 — an ExecutionContext synthesised from a socket handshake.
//
// THE ALTERNATIVE, AND WHY IT WAS REJECTED. All three guards read
// `context.switchToHttp().getRequest()`. The obvious change is to make them
// `context.getType()`-aware so they can read a socket directly — and that
// edits `auth.guard.ts`, `workspace.guard.ts` and `rbac.guard.ts`, files owned
// by STORY-014, STORY-018 and STORY-019. Three security-critical files edited
// by a realtime story, to add a branch that every future guard must then
// remember to implement.
//
// Synthesising the context instead means the guards run UNMODIFIED — the same
// classes, resolved from the same DI container, with the same logic. Not
// "equivalent logic": the same objects. `test/unit/gateway-structure.spec.ts`
// asserts the instances are identical to the ones the HTTP path uses, because
// "we reuse the guards" is exactly the kind of claim that quietly stops being
// true.
//
// The socket handshake carries what a request carries — headers and cookies —
// so the shape below is a genuine adapter rather than a stub. What it
// deliberately does NOT provide is a handler or a controller class with route
// metadata: a socket join is not a route, has no `@Public()` and no
// `@RequirePermission()`, and inventing a handler to hang metadata on would be
// inventing a route that does not exist.

/** The subset of a socket handshake this needs. Kept minimal so a test needs no real socket.io server. */
export interface HandshakeLike {
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly auth?: Record<string, unknown>;
}

/** What the guards populate as they run, and what room authorisation reads afterwards. */
export interface WsScopedRequest {
  headers: Record<string, string | string[] | undefined>;
  cookies: Record<string, string | undefined>;
  method: string;
  url: string;
  authMethod?: "session" | "apiKey";
  auth?: unknown;
  tenant?: unknown;
  membership?: unknown;
}

/**
 * Parses a `Cookie` header.
 *
 * AuthGuard reads `req.cookies`, which on the HTTP path is populated by
 * `@fastify/cookie`. A socket handshake has the raw header and no plugin, so
 * the parsing happens here — and it must match, or a token that authenticates
 * over HTTP would fail over a socket for reasons that look like an auth bug.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string | undefined> {
  if (header === undefined || header.length === 0) return {};
  const cookies: Record<string, string | undefined> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length === 0) continue;
    // FIRST WINS, matching `cookie`'s own semantics as bundled by
    // `@fastify/cookie`. This kept the LAST occurrence, so a duplicate cookie
    // name resolved to a different value on a socket than on an HTTP request
    // with the identical header.
    if (Object.prototype.hasOwnProperty.call(cookies, name)) continue;
    cookies[name] = decodeValue(value);
  }
  return cookies;
}

/**
 * Decodes one cookie value, falling back to the raw string.
 *
 * `decodeURIComponent` THROWS on a malformed escape, and `cookie`'s own decode
 * catches that and returns the value untouched. This did not, and the throw
 * escaped `parseCookieHeader` -> `requestFromHandshake` -> outside the guard
 * loop's try/catch, so a handshake carrying `__Host-nominara-access=a%b` got a
 * generic exception frame instead of a 4403, STAYED CONNECTED, and incremented
 * no refusal metric. That is the enumeration oracle `joinWorkspace`'s own
 * comment forbids, reachable with one character. Found by the dangerous-area
 * audit and reproduced end to end.
 */
function decodeValue(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Builds the request the guards will read and populate.
 *
 * `method` and `url` are set because a guard may log or branch on them; they
 * describe the socket accurately rather than pretending to be a GET of
 * something.
 */
export function requestFromHandshake(handshake: HandshakeLike): WsScopedRequest {
  const headers = handshake.headers ?? {};
  const cookieHeader = Array.isArray(headers.cookie) ? headers.cookie[0] : headers.cookie;
  return {
    headers,
    cookies: parseCookieHeader(cookieHeader),
    method: "WS",
    url: "/rt",
  };
}

/**
 * Wraps a request in an ExecutionContext the existing guards accept.
 *
 * `getHandler()` and `getClass()` return objects carrying NO metadata, so
 * `reflector.getAllAndOverride` finds nothing for every key it looks up. That
 * is the correct answer rather than a convenient one: a socket join is not
 * `@Public()`, so AuthGuard runs in full; and it carries no
 * `@RequirePermission()`, so RbacGuard applies no permission requirement —
 * membership itself is what room authorisation checks, immediately after.
 */
export function executionContextForSocket(request: WsScopedRequest): ExecutionContext {
  class SocketJoin {}
  function socketJoinHandler(): void {}

  const http = {
    getRequest: <T>(): T => request as T,
    // A guard that reached for the response would be doing something a socket
    // cannot honour — setting a header on a connection that has none. Throwing
    // names that rather than handing back a silent no-op object that would let
    // the guard believe it succeeded.
    getResponse: (): never => {
      throw new Error(
        "ws-execution-context: a socket join has no HTTP response. A guard that writes to the reply cannot be " +
          "reused on the socket path as-is — see test/unit/gateway-structure.spec.ts.",
      );
    },
    getNext: (): never => {
      throw new Error("ws-execution-context: there is no next() on a socket join");
    },
  };

  return {
    getType: () => "ws",
    getHandler: () => socketJoinHandler,
    getClass: () => SocketJoin,
    switchToHttp: () => http,
    switchToRpc: () => {
      throw new Error("ws-execution-context: not an RPC context");
    },
    switchToWs: () => {
      throw new Error("ws-execution-context: the guards read switchToHttp(); see this file's header");
    },
    getArgs: () => [request],
    getArgByIndex: () => request,
  } as unknown as ExecutionContext;
}
