import { describe, expect, it } from "vitest";
import { GeminiNaturaliser } from "./adapters/gemini-naturaliser.js";
import { selectNaturaliser } from "./naturaliser.selector.js";

// STORY-045 AC3 - the naturaliser is swappable by configuration, and a missing key degrades to the template-only path.

describe("STORY-045 AC3 - selectNaturaliser", () => {
  it("is null by default: the deterministic template-only path", () => {
    expect(selectNaturaliser({ PROMPT_NATURALISER: "none", GEMINI_API_KEY: "k", PROMPT_NATURALISER_MODEL: "m", PROMPT_NATURALISER_TIMEOUT_MS: 8000 })).toBeNull();
  });

  it("binds the Gemini adapter when configured and keyed", () => {
    const picked = selectNaturaliser({ PROMPT_NATURALISER: "gemini", GEMINI_API_KEY: "k", PROMPT_NATURALISER_MODEL: "gemini-2.5-flash", PROMPT_NATURALISER_TIMEOUT_MS: 8000 });
    expect(picked).toBeInstanceOf(GeminiNaturaliser);
  });

  it.each([undefined, ""])("falls back to null (template-only) rather than failing when the key is %j", (key) => {
    expect(selectNaturaliser({ PROMPT_NATURALISER: "gemini", GEMINI_API_KEY: key, PROMPT_NATURALISER_MODEL: "m", PROMPT_NATURALISER_TIMEOUT_MS: 8000 })).toBeNull();
  });
});
