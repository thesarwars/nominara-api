import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GRAMMAR_VERSION } from "./archetypes.js";
import { l5TemplateCacheKey } from "./cache-key.js";
import { normalizeTopic, singularise, TOPIC_STOPWORDS } from "./normalize.js";
import { promptTextHash } from "./text-hash.js";

// STORY-045 — §4 step 1 NORMALIZE, and the two keys derived from it.
//
//   topic "HubSpot lead software"
//    1. NORMALIZE  lowercase, strip stopwords and punctuation, lemmatise the
//                  head noun -> the dedupe key and the L5 cache key input
//
// THREE NORMALISATIONS EXIST IN THIS CODEBASE and they are not
// interchangeable. This file covers the topic one (aggressive, §4 step 1) and
// asserts that the prompt-text one is REUSED from capture/l1-cache-key.ts
// rather than reimplemented — because `text_hash` is documented as both the
// dedupe key and part of the L1 cache key, and two normalisations that
// disagree would dedupe prompts L1 then treats as different questions.

describe("STORY-045 · normalizeTopic", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeTopic("  HubSpot   Lead   Software ")).toBe("hubspot lead software");
  });

  it("strips punctuation", () => {
    expect(normalizeTopic("lead-management, software!")).toBe("lead management software");
  });

  it("strips stopwords", () => {
    expect(normalizeTopic("software for the management of leads")).toBe("software management lead");
  });

  it("lemmatises the head noun — the LAST token, English being right-headed", () => {
    expect(normalizeTopic("lead management platforms")).toBe("lead management platform");
    expect(normalizeTopic("marketing companies")).toBe("marketing company");
    expect(normalizeTopic("support boxes")).toBe("support box");
  });

  it("lemmatises ONLY the head noun, leaving modifiers alone", () => {
    // "sales analytics tools" -> the modifier `analytics` is not a plural to
    // strip; singularising every token turns it into "analytic", which is a
    // different word and a worse cache key.
    expect(normalizeTopic("sales analytics tools")).toBe("sales analytics tool");
  });

  it("is idempotent — normalising an already-normalised topic changes nothing", () => {
    const once = normalizeTopic("Best CRM Platforms for Mid-Market Teams?");
    expect(normalizeTopic(once)).toBe(once);
  });

  it("never returns an empty string for input that had any word in it", () => {
    // A topic of pure stopwords would otherwise normalise to "" and every
    // such project would share one L5 cache entry.
    expect(normalizeTopic("for the of and")).not.toBe("");
  });

  it("returns an empty string only for genuinely empty input", () => {
    expect(normalizeTopic("")).toBe("");
    expect(normalizeTopic("   ")).toBe("");
    expect(normalizeTopic("!!!")).toBe("");
  });

  it("keeps stopwords out of the middle of a term rather than only at the edges", () => {
    expect(normalizeTopic("crm for a sales team")).toBe("crm sales team");
  });

  it("holds a stopword list short enough to read in a diff", () => {
    // Same reasoning discovery's common-words.ts records: this is a curated
    // list of words that actually collide, not a downloaded corpus.
    expect(TOPIC_STOPWORDS.size).toBeGreaterThan(10);
    expect(TOPIC_STOPWORDS.size).toBeLessThan(80);
    expect(TOPIC_STOPWORDS.has("the")).toBe(true);
    // NOT a stopword: it is a real modifier in "best CRM", which is exactly
    // the kind of buyer phrasing a topic carries.
    expect(TOPIC_STOPWORDS.has("best")).toBe(false);
  });
});

describe("STORY-045 · singularise", () => {
  it("handles the four English plural endings that actually occur here", () => {
    expect(singularise("platforms")).toBe("platform");
    expect(singularise("companies")).toBe("company");
    expect(singularise("boxes")).toBe("box");
    expect(singularise("analyses")).toBe("analysis");
  });

  it("leaves a word that is already singular alone", () => {
    expect(singularise("software")).toBe("software");
    expect(singularise("crm")).toBe("crm");
  });

  it("leaves an -ss word alone rather than making it -s", () => {
    // "business" -> "busines" would be a silent corruption of the head noun
    // in a cache key, invisible until someone reads a stored key.
    expect(singularise("business")).toBe("business");
    expect(singularise("access")).toBe("access");
  });

  it("leaves a short word alone", () => {
    // Stripping the -s from "sms" or "ops" produces a non-word.
    expect(singularise("ops")).toBe("ops");
    expect(singularise("as")).toBe("as");
  });

  it("is deterministic and total — never throws, whatever it is given", () => {
    for (const word of ["", "s", "ss", "ies", "es", "x", "status", "series"]) {
      expect(() => singularise(word)).not.toThrow();
    }
  });
});

describe("STORY-045 · promptTextHash", () => {
  it("returns both wire and storage forms of the same digest", () => {
    const hash = promptTextHash("Which CRM do you recommend for mid-market sales teams?");
    expect(hash.wire).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hash.bytes).toBeInstanceOf(Buffer);
    expect(hash.bytes.toString("hex")).toBe(hash.wire.slice("sha256:".length));
  });

  it("REUSES capture/l1-cache-key.ts's prompt normalisation, byte for byte", () => {
    // `schemas/projects-and-prompts.md` documents text_hash as both the
    // dedupe key AND part of the L1 cache key. A second, more aggressive
    // normalisation here would dedupe two prompts that L1 goes on to treat
    // as different questions — the dedupe would be a lie and the cache
    // sharing would silently fragment.
    const expected = createHash("sha256").update("best crm for a 50-rep sales team").digest("hex");
    expect(promptTextHash("  Best CRM   for a 50-rep sales team  ").wire).toBe(`sha256:${expected}`);
  });

  it("treats trivial typing differences as the same prompt", () => {
    expect(promptTextHash("Best CRM").wire).toBe(promptTextHash("  best   crm ").wire);
  });

  it("treats a genuinely different question as different", () => {
    expect(promptTextHash("Best CRM").wire).not.toBe(promptTextHash("Best CRM?").wire);
  });
});

describe("STORY-045 · l5TemplateCacheKey", () => {
  it("is built from topic, locale and grammar version — §8's three inputs", () => {
    const key = l5TemplateCacheKey({ env: "test", workspaceId: "01a00000-0000-7000-8000-0000000000aa", topicNorm: "lead management platform", locale: "en-US" });
    expect(key).toContain("test:");
    expect(key).toMatch(/promptgen/);
  });

  it("is TENANT-SCOPED", () => {
    // ISO-13 scopes every key to its tenant, and its ONE documented
    // exception is `{env}:global:capture:` — which is excepted precisely
    // because an L1 entry holds an engine's public answer and carries no
    // tenant data. An L5 entry is keyed on a customer's topic, so it is not
    // covered by that exception and must not borrow it.
    const a = l5TemplateCacheKey({ env: "test", workspaceId: "01a00000-0000-7000-8000-0000000000aa", topicNorm: "crm", locale: "en-US" });
    const b = l5TemplateCacheKey({ env: "test", workspaceId: "01a00000-0000-7000-8000-0000000000bb", topicNorm: "crm", locale: "en-US" });
    expect(a).not.toBe(b);
    expect(a).not.toContain("global");
  });

  it("changes when the grammar version changes", () => {
    // Otherwise a surface edit serves the old wording from cache for thirty
    // days, and FR-FAN-01d's determinism claim quietly stops holding.
    const key = l5TemplateCacheKey({ env: "test", workspaceId: "01a00000-0000-7000-8000-0000000000aa", topicNorm: "crm", locale: "en-US" });
    const other = l5TemplateCacheKey({
      env: "test",
      workspaceId: "01a00000-0000-7000-8000-0000000000aa",
      topicNorm: "crm",
      locale: "en-US",
      grammarVersion: "g99",
    });
    expect(other).not.toBe(key);
    expect(key).toBe(
      l5TemplateCacheKey({
        env: "test",
        workspaceId: "01a00000-0000-7000-8000-0000000000aa",
        topicNorm: "crm",
        locale: "en-US",
        grammarVersion: GRAMMAR_VERSION,
      }),
    );
  });

  it("changes when the locale changes", () => {
    const en = l5TemplateCacheKey({ env: "test", workspaceId: "01a00000-0000-7000-8000-0000000000aa", topicNorm: "crm", locale: "en-US" });
    const de = l5TemplateCacheKey({ env: "test", workspaceId: "01a00000-0000-7000-8000-0000000000aa", topicNorm: "crm", locale: "de-DE" });
    expect(en).not.toBe(de);
  });

  it("cannot be confused by a topic containing the separator", () => {
    // A length-prefixed join, the same defence l1-cache-key.ts uses: `a|b`
    // and `ab|` must not hash alike, or a topic can impersonate a locale.
    const a = l5TemplateCacheKey({ env: "test", workspaceId: "01a00000-0000-7000-8000-0000000000aa", topicNorm: "crm|en", locale: "US" });
    const b = l5TemplateCacheKey({ env: "test", workspaceId: "01a00000-0000-7000-8000-0000000000aa", topicNorm: "crm", locale: "en|US" });
    expect(a).not.toBe(b);
  });
});
