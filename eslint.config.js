import js from "@eslint/js";
import tseslint from "typescript-eslint";
import metricNameConvention from "./eslint-rules/metric-name-convention.js";
import noPoolLevelTenantQuery from "./eslint-rules/no-pool-level-tenant-query.js";
import noRepositoryLayer from "./eslint-rules/no-repository-layer.js";
import noRequestHandlerNetworkCall from "./eslint-rules/no-request-handler-network-call.js";
import noSessionScopedConfig from "./eslint-rules/no-session-scoped-config.js";
import noSpendMeterPostgresAccess from "./eslint-rules/no-spend-meter-postgres-access.js";

// STORY-011 — NFR-SEC-02. An inline local plugin (flat config supports this
// natively, no new dependency) rather than a published package: the rule is
// specific to this repo's own GUC/pooling story and has no reason to exist
// outside it.
const nominaraLocalPlugin = {
  rules: {
    "no-session-scoped-config": noSessionScopedConfig,
    "no-request-handler-network-call": noRequestHandlerNetworkCall,
    "no-repository-layer": noRepositoryLayer,
    "no-spend-meter-postgres-access": noSpendMeterPostgresAccess,
    "no-pool-level-tenant-query": noPoolLevelTenantQuery,
    "metric-name-convention": metricNameConvention,
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
  {
    // STORY-118 — NFR-SEC-01's other half. src/tenancy/query-guard.ts
    // refuses a pool-level tenant-table query at runtime; this refuses it at
    // the point it is written, so a path no test exercises (a socket
    // handshake, a health probe) cannot ship one. Scoped to src/** only:
    // test files connect as the migration owner and seed tenant tables
    // through the pool deliberately.
    files: ["src/**/*.ts"],
    rules: {
      "nominara/no-pool-level-tenant-query": "error",
    },
  },
  {
    // STORY-133 - NFR-ARCH-01 from the other direction. The embedding-provider port, its adapters and its selector are reachable
    // from the `embed.batch` handler and from nowhere else: a request handler (or any other module) importing them is how a
    // provider call ends up on the request path. Tests may import them to fake or exercise them.
    files: ["src/**/*.ts"],
    ignores: [
      "src/lib/queue/handlers/embed-batch.handler.ts",
      "src/modules/prompts/adapters/*-embedding-provider.ts",
      "src/modules/prompts/embedding-provider.selector.ts",
      "src/modules/prompts/ports/embedding-provider.ts",
      "**/*.spec.ts",
      "**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/ports/embedding-provider.js", "**/embedding-provider.selector.js", "**/adapters/*-embedding-provider.js"],
              message:
                "The embedding provider is reachable only from the embed.batch handler (STORY-133, NFR-ARCH-01): a request handler must enqueue an embed.batch job, never call the provider.",
            },
          ],
        },
      ],
    },
  },
  {
    // STORY-005 AC8 - coding-standards.md section 7: nominara_<subsystem>_<measure> with the unit in the name. Tests call the
    // metric helpers with throwaway names on purpose.
    files: ["src/**/*.ts"],
    ignores: ["**/*.spec.ts", "**/*.test.ts"],
    rules: {
      "nominara/metric-name-convention": "error",
    },
  },
  {
    // STORY-031 D12. Scoped to exactly this one file — the AST-level
    // enforcement of D12's guarantee, replacing the defeatable text-regex
    // structural test in test/unit/engines/spend-meter.spec.ts.
    files: ["src/lib/engines/spend-meter.ts"],
    rules: {
      "nominara/no-spend-meter-postgres-access": "error",
    },
  },
);
