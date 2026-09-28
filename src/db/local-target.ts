// STORY-169 — shared "is this connection string local" guard, extracted from
// `src/db/studio.ts` so a second tool (the dev-only demo seed) can reuse the
// exact same allow-list rather than retyping it and risking the two drifting
// apart. Studio's own behaviour and error message are UNCHANGED — it still
// exports `assertLocalTarget`/`NonLocalStudioTargetError` itself, now built
// on top of the pieces here — so `test/unit/studio-target.spec.ts` needed no
// edit.
//
// This module makes no NODE_ENV or opt-in decision of its own. It only
// answers "is this host one of a developer's own machine, and nothing else",
// which is one of several independent checks a caller composes — see
// `src/db/seed/demo/guard.ts` for the demo seed's fuller refusal, which adds
// NODE_ENV=production and an explicit opt-in on top of this.

/** Hostnames that are a developer's own machine, and nothing else. */
export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal", "postgres"]);

/**
 * The hostname a connection string names, or a fixed placeholder for one
 * that cannot be parsed at all — never throws, so a caller can report an
 * unparseable URL by name rather than by crash.
 */
export function hostnameOf(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

/** Whether `databaseUrl` names a host in `LOCAL_HOSTS` — false for an unparseable URL, never a throw. */
export function isLocalTarget(databaseUrl: string): boolean {
  return LOCAL_HOSTS.has(hostnameOf(databaseUrl));
}
