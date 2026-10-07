import type net from "node:net";

// STORY-174 — the runtime half of the "tests never reach a developer's
// service" guarantee (installed by test-valkey-env.ts in every worker). Split
// out so its spec can drive it with a FAKE socket prototype: proving it works
// must never open a real connection to the very ports it exists to protect.

export interface ConnectTarget {
  readonly host: string;
  readonly port: number;
}

/** The (host, port) a `Socket.prototype.connect` call is about to dial, or undefined for a unix-socket/unparseable call. */
export function connectTargetOf(args: readonly unknown[]): ConnectTarget | undefined {
  // Node normalises to a single array argument on some internal paths.
  const flat: readonly unknown[] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  const [a, b] = flat;
  if (typeof a === "object" && a !== null) {
    const options = a as { port?: unknown; host?: unknown; path?: unknown };
    if (options.path !== undefined || options.port === undefined) return undefined;
    return { host: typeof options.host === "string" ? options.host : "localhost", port: Number(options.port) };
  }
  if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) {
    return { host: typeof b === "string" ? b : "localhost", port: Number(a) };
  }
  return undefined;
}

type ConnectFn = (this: net.Socket, ...args: unknown[]) => net.Socket;

/**
 * Replaces `proto.connect` with a version that refuses (and records) any dial
 * `isForbidden` rejects: the socket is destroyed with an error instead of
 * connecting. Returns the restore function.
 */
export function installConnectTripwire(
  proto: { connect: unknown },
  isForbidden: (target: ConnectTarget) => boolean,
  record: (message: string) => void,
): () => void {
  const original = proto.connect as ConnectFn;
  proto.connect = function patchedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const target = connectTargetOf(args);
    if (target !== undefined && isForbidden(target)) {
      const message = `a test tried to connect to ${target.host}:${String(target.port)}, a developer service port (STORY-174)`;
      record(message);
      process.nextTick(() => this.destroy(new Error(message)));
      return this;
    }
    return original.apply(this, args);
  };
  return () => {
    proto.connect = original;
  };
}
