<!-- Carry to the docs repo: stories/<area>/STORY-085-*.md, Test scenario 11 (line 74). Nominara-Dev-Docs-main has no .git. Owner decision 2026-10-08 (lead's call, decisions-2026-10-08.md "STORY-085 #11"). -->

| 11 | **Instrument writes and queues across a parse of all fourteen intents** | **Zero jobs, zero external work, zero writes to any table except `audit_log`; the one row a parse writes is the outcome-only `command.parsed` audit row (`{intent, resolved_by, cached, confidence}`; no query text, no slots)** |
