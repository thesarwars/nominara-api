# NEW-A-4 live Gemini smoke — evidence (CP1 QA, AC6)

Run 2026-10-07 by hand from the 7day/a-gemini-2 worktree (base fb50262, spec extended in this commit).

    GEMINI_LIVE=1 GEMINI_API_KEY=<redacted> pnpm vitest run src/lib/engines/gemini/gemini.live.spec.ts

Model gemini-2.5-flash, plain fetch, google_search tool, prompt "What are the best CRM tools for a 50-person startup?".

Result (exit 0, 1 test passed):

    gemini-live-smoke citations=10 resolved=10 distinctDomains=9 latencyMs=10570

What this proves: the capture passed rawCaptureSchema; text, citations and latency present; the capture then went through
the real parse stage (parseCapture, default guarded fetch) and the 10 vertexaisearch grounding redirects ALL resolved to
9 distinct domains, none of them the wrapper host. The spec now asserts resolved > 1, distinct domains > 1, and no
resolved domain under vertexaisearch.cloud.google.com.

Notes: an earlier attempt the same minute failed `upstream_5xx` — the vendor returned 503 UNAVAILABLE ("high demand"),
confirmed with a direct request; the adapter classified it correctly. The run above is the next attempt. The spec stays
opt-in (GEMINI_LIVE=1 and a key); CI sets neither. The key is not committed anywhere.
