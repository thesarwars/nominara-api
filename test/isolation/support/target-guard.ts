import { ASSERTIONS, selectAssertionsForTarget } from "../assertions/registry.js";
import { getIsolationProvidedContext } from "./context.js";

// STORY-012 T24 — every green spec wrapper calls this so ISOLATION_TARGET=staging
// actually narrows to the read-only, fixture-independent subset (registry.ts's
// selectAssertionsForTarget) rather than that filter existing only on paper.
export function isRunnableForCurrentTarget(id: string): boolean {
  const { target } = getIsolationProvidedContext();
  const runnable = new Set(selectAssertionsForTarget(target).map((e) => e.id));
  if (!ASSERTIONS.some((e) => e.id === id)) {
    throw new Error(`target-guard: "${id}" is not a registered assertion id`);
  }
  return runnable.has(id);
}
