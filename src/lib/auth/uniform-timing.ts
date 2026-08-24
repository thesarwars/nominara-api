// STORY-016 — the primitive that closes the request-endpoint timing side
// channel (AC "identical response and an indistinguishable duration
// whether or not an account exists"). `fn()` and a floor sleep run
// concurrently; the wrapped call only settles once BOTH have completed, so
// total wall time is max(floorMs, fn()'s duration) — never less than the
// floor regardless of whether fn() resolves or rejects, and never
// truncated when fn() runs longer than the floor.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Outcome<T> = { readonly status: "fulfilled"; readonly value: T } | { readonly status: "rejected"; readonly reason: unknown };

async function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

/**
 * Runs `fn()` and a `floorMs` sleep concurrently, resolving with `fn()`'s
 * value (or rethrowing its rejection) only once both have completed.
 */
export async function withUniformDuration<T>(floorMs: number, fn: () => Promise<T>): Promise<T> {
  const floor = sleep(floorMs);
  const outcome = await settle(fn());
  await floor;
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}
