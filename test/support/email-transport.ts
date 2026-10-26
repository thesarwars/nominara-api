import { expect } from "vitest";

// STORY-178 — `selectEmailSender()` wraps whatever transport it picks in the suppression check, so a test that asks "which
// transport was chosen" unwraps it. Duck-typed (not `instanceof`): selection specs reset the module registry between cases.
export function transportOf(sender: unknown): { constructor: { name: string } } {
  const wrapper = sender as { constructor: { name: string }; transport?: { constructor: { name: string } } };
  expect(wrapper.constructor.name, "every selected sender is wrapped by the suppression check").toBe("SuppressingEmailSender");
  expect(wrapper.transport).toBeDefined();
  return wrapper.transport!;
}
