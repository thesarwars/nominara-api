import js from "@eslint/js";
import tseslint from "typescript-eslint";
import noRepositoryLayer from "./eslint-rules/no-repository-layer.js";
import noRequestHandlerNetworkCall from "./eslint-rules/no-request-handler-network-call.js";
import noSessionScopedConfig from "./eslint-rules/no-session-scoped-config.js";

// STORY-011 — NFR-SEC-02. An inline local plugin (flat config supports this
// natively, no new dependency) rather than a published package: the rule is
// specific to this repo's own GUC/pooling story and has no reason to exist
// outside it.
const nominaraLocalPlugin = {
  rules: {
    "no-session-scoped-config": noSessionScopedConfig,
    "no-request-handler-network-call": noRequestHandlerNetworkCall,
    "no-repository-layer": noRepositoryLayer,
  },
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "client/src/**", "client/dist/**"],
  },
  {
    plugins: {
      nominara: nominaraLocalPlugin,
    },
    rules: {
      // Sequence numbers double as the migration ordering contract — an
      // unused import here usually means a copy-paste error worth seeing.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "nominara/no-session-scoped-config": "error",
    },
  },
  {
    // STORY-022 — NFR-ARCH-01. The request path: module controllers/services
    // and the HTTP composition root. Excludes src/workers/** entirely —
    // workers are where the enqueued call is dequeued and actually made.
    //
    // `src/gateway/**` is here because OQ-12 settled it there and only
    // `src/contracts/**` was actually added — leaving the largest new surface
    // in EPIC-03, and the one that opens raw Redis connections, outside the
    // epic's own lint-enforced quality criterion. Found in the STORY-026
    // review. This TIGHTENS a gate, never relaxes one.
    files: [
      "src/modules/**/*.controller.ts",
      "src/modules/**/*.service.ts",
      "src/api/**/*.ts",
      "src/contracts/**/*.ts",
      "src/gateway/**/*.ts",
    ],
    rules: {
      "nominara/no-request-handler-network-call": "error",
    },
  },
  {
    // STORY-022 — NFR-ARCH-09. Scoped to the module tree, where a
    // repository/mapper/CQRS layer would otherwise slip in between a
    // service and Drizzle.
    files: ["src/modules/**/*.ts"],
    rules: {
      "nominara/no-repository-layer": "error",
    },
  },
);
