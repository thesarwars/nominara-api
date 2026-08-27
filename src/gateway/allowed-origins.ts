/**
 * STORY-026 — `REALTIME_ALLOWED_ORIGINS`, parsed.
 *
 * Its own module so it is testable without booting a gateway. The provider in
 * `gateway.module.ts` runs inside `NestFactory.create`, which aborts the
 * PROCESS on a provider error (`abortOnError` defaults to true) — so a spec
 * asserting the refusal through the module would take the test worker down
 * with it, and the guard would go untested precisely because it works.
 */
export class MissingAllowedOriginsError extends Error {
  constructor() {
    super(
      "REALTIME_ALLOWED_ORIGINS is required by the gateway: it is the socket handshake's Origin allow-list, " +
        "and an empty one would admit any same-site origin. Set it to the origins permitted to open a socket.",
    );
    this.name = "MissingAllowedOriginsError";
  }
}

/**
 * Splits the comma-separated list, and REFUSES an empty one.
 *
 * The key is optional in the global env schema because only the gateway opens
 * sockets — the API, the worker and the one-shot migrate container have no use
 * for it. The requirement lives here instead, with the thing that needs it.
 *
 * An empty allow-list is rejected rather than treated as "allow everything".
 * A permissive default is the shape of defect this story exists to remove: a
 * check that passes whether or not the thing works. A deployment that has not
 * decided its origins gets a gateway that does not start, which is loud, over
 * one that admits a hostile same-site subdomain, which is silent.
 */
export function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  const origins = (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (origins.length === 0) {
    throw new MissingAllowedOriginsError();
  }
  return origins;
}
