// Owner decision 42 - re-record the OpenRouter response fixtures (src/lib/engines/openrouter/fixtures/openrouter-recorded.ts) once the
// owner tops up credit. MANUAL. Every engine call SPENDS CREDIT (about $0.07 gpt-5.4, $0.11 claude-sonnet-5.5, $0.006 perplexity/sonar).
//
//   OPENROUTER_LIVE=1 OPENROUTER_API_KEY=... node scripts/record-openrouter-fixtures.mjs <output-dir>
//
// It writes one raw JSON file per call into <output-dir> and prints only status, model and counts. It never prints the key or the answer
// text. Then, BY HAND: replace each `id` with a placeholder (gen-recorded-...), empty `reasoning_details` / `reasoning`, check nothing
// account-identifying remains, and paste into openrouter-recorded.ts. Request bodies match buildOpenRouterRequest (openrouter-adapter.ts):
// the web plugin on the native engine for chatgpt and claude, NO plugin for perplexity (sonar is search-native; the plugin answers 404).
// Calls made: 3 engines + 1 free model. The free model is capped at 50 requests a day on an account with no credit.
import console from "node:console";
import { mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";

if (process.env.OPENROUTER_LIVE !== "1") {
  console.error("refusing: set OPENROUTER_LIVE=1 (each run spends OpenRouter credit)");
  process.exit(2);
}

const key = process.env.OPENROUTER_API_KEY;
const out = process.argv[2];
if (!key || !out) {
  console.error("usage: OPENROUTER_API_KEY=... node scripts/record-openrouter-fixtures.mjs <output-dir>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const prompt = "What are the best CRM tools for a 50-person startup?";
const web = [{ id: "web", engine: "native", max_results: 5 }];
const calls = [
  { name: "perplexity", body: { model: "perplexity/sonar", messages: [{ role: "user", content: prompt }] } },
  { name: "chatgpt", body: { model: "openai/gpt-5.4", messages: [{ role: "user", content: prompt }], plugins: web } },
  { name: "claude", body: { model: "anthropic/claude-sonnet-5.5", messages: [{ role: "user", content: prompt }], plugins: web } },
  { name: "free", body: { model: "google/gemma-4-26b-a4b-it:free", messages: [{ role: "user", content: prompt }] } },
];

for (const { name, body } of calls) {
  const started = Date.now();
  const res = await globalThis.fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, max_tokens: 4096, usage: { include: true } }),
  });
  const text = await res.text();
  writeFileSync(`${out}/${name}.json`, text);
  const summary = (() => {
    try {
      const parsed = JSON.parse(text);
      const message = parsed.choices?.[0]?.message;
      return `model=${parsed.model ?? "-"} annotations=${message?.annotations?.length ?? 0} finish=${parsed.choices?.[0]?.finish_reason ?? "-"} cost=${parsed.usage?.cost ?? "-"}`;
    } catch {
      return "non-JSON body";
    }
  })();
  console.log(`${name}: status=${res.status} ms=${Date.now() - started} ${summary}`);
}
