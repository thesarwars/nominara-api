// STORY-022 — coding-standards.md §1/§4, NFR-ARCH-01: "No API request
// handler may perform a network call to an engine, embedding provider, or
// crawl target. All such work is enqueued." Scoped (in eslint.config.js's
// `files`) to src/modules/**/*.controller.ts, src/modules/**/*.service.ts,
// and src/api/**/*.ts — excludes src/workers/** entirely, since workers are
// exactly where that network call is SUPPOSED to happen once dequeued.
//
// A generic dependency-boundary rule, not a domain classifier: it can't know
// which URL is "an engine" at lint time, so it bans the KNOWN network-call
// surfaces outright from these files — importing them, or calling the global
// fetch — same category of heuristic as no-session-scoped-config.js (fast,
// loud, not a runtime security boundary).

const BANNED_MODULES = new Set([
  "axios",
  "got",
  "node-fetch",
  "undici",
  "http",
  "https",
  "node:http",
  "node:https",
]);

/** @type {import('eslint').Rule.RuleModule} */
const noRequestHandlerNetworkCall = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Bans a network call to an engine, embedding provider, or crawl target from a request handler. NFR-ARCH-01 — that work must be enqueued, never awaited on the request path.",
    },
    schema: [],
    messages: {
      bannedImport:
        "'{{source}}' is a direct network-call surface and may not be imported here — enqueue the call on BullMQ instead (NFR-ARCH-01). This file is on the request path.",
      bannedFetchCall:
        "Calling fetch() directly is a network call on the request path — enqueue the work on BullMQ instead (NFR-ARCH-01).",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source === "string" && BANNED_MODULES.has(source)) {
          context.report({ node, messageId: "bannedImport", data: { source } });
        }
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "fetch") {
          context.report({ node, messageId: "bannedFetchCall" });
        }
      },
    };
  },
};

export default noRequestHandlerNetworkCall;
