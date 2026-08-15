import js from "@eslint/js";
import tseslint from "typescript-eslint";
import noSessionScopedConfig from "./eslint-rules/no-session-scoped-config.js";

// STORY-011 — NFR-SEC-02. An inline local plugin (flat config supports this
// natively, no new dependency) rather than a published package: the rule is
// specific to this repo's own GUC/pooling story and has no reason to exist
// outside it.
const nominaraLocalPlugin = {
  rules: {
    "no-session-scoped-config": noSessionScopedConfig,
  },
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**"],
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
);
