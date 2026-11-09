import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODEL_VENDORS } from "./model-vendors.js";

// STORY-111 / NFR-CMP-11. Scenarios 27 and 28.
const SRC = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "fixtures" || name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const files = sourceFiles(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, "utf8") }));

describe("STORY-111 no training pipeline (scenario 27)", () => {
  it("S27 no source file trains, fine-tunes or uploads training data to anything", () => {
    const forbidden = /fine[-_ ]?tun|\/fine_tuning|training[_-]?(data|set|file|job)|trainModel|\.train\(|tuning[_-]?job/i;
    const hits = files.filter((f) => !f.path.startsWith("lib/compliance/model-vendors") && forbidden.test(f.text)).map((f) => f.path);
    expect(hits).toEqual([]);
  });
});

describe("STORY-111 every model call has a documented training opt-out position (scenario 28)", () => {
  const hostPattern = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;
  const hostsInSource = new Set<string>();
  for (const f of files) {
    if (f.path.startsWith("lib/compliance/model-vendors")) continue;
    for (const m of f.text.matchAll(hostPattern)) hostsInSource.add(m[1]!.toLowerCase());
  }

  it("S28 every host that a model call goes to is in MODEL_VENDORS (a new vendor cannot be added unrecorded)", () => {
    const model = /generativelanguage\.googleapis\.com|openrouter\.ai|api\.openai\.com|anthropic\.com|api\.mistral|cohere\.|perplexity\.ai|x\.ai|deepseek|together\.xyz|groq\.com|huggingface\.co/;
    const modelHosts = [...hostsInSource].filter((h) => model.test(h));
    expect(modelHosts.length).toBeGreaterThan(0);
    const registered = new Set(MODEL_VENDORS.map((v) => v.host));
    expect(modelHosts.filter((h) => !registered.has(h))).toEqual([]);
  });

  it("S28 each vendor states what it is sent and where; a `confirmed` opt-out must cite its evidence, a missing one must say it is pending", () => {
    for (const v of MODEL_VENDORS) {
      expect(v.calls.length, v.host).toBeGreaterThan(0);
      expect(v.sends.length, v.host).toBeGreaterThan(20);
      if (v.trainingOptOut === "confirmed") expect(v.evidence, v.host).not.toBeNull();
      else expect(v.evidence, v.host).toBeNull();
    }
  });

  it("S28 the call sites the registry names exist", () => {
    for (const v of MODEL_VENDORS) for (const call of v.calls) expect(files.some((f) => `src/${f.path}` === call.split(" - ")[0]), call).toBe(true);
  });
});
