import { RuleTester } from "eslint";
import { describe, it } from "vitest";
// @ts-expect-error — plain JS rule module, no type declarations.
import noRequestHandlerNetworkCall from "../../eslint-rules/no-request-handler-network-call.js";

// STORY-022 scenario 4 — "Add a handler that calls an engine → Lint fails."
// Same RuleTester/vitest wiring pattern as no-session-scoped-config.spec.ts
// (STORY-011) — RuleTester.describe/it delegate to real vitest describe/it
// so each case is independently reported.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

describe("STORY-022 · eslint-rules/no-request-handler-network-call", () => {
  ruleTester.run("no-request-handler-network-call", noRequestHandlerNetworkCall, {
    valid: [
      {
        name: "enqueuing a job on BullMQ is permitted",
        code: `
          async function triggerRun(id, body) {
            const run = await this.tracking.createRun(id, body);
            await this.queue.add('capture.plan', signJob({ workspaceId: run.workspaceId, runId: run.id }));
            return { data: run };
          }
        `,
      },
      { name: "importing drizzle-orm is unrelated to a network call", code: `import { eq } from "drizzle-orm";` },
      { name: "importing zod is unrelated to a network call", code: `import { z } from "zod";` },
    ],
    invalid: [
      {
        name: "importing axios in a handler is a deliberate violation — lint fails",
        code: `import axios from "axios";`,
        errors: [{ messageId: "bannedImport" }],
      },
      {
        name: "importing node:http in a handler is a deliberate violation — lint fails",
        code: `import http from "node:http";`,
        errors: [{ messageId: "bannedImport" }],
      },
      {
        name: "calling global fetch() directly in a handler is a deliberate violation — lint fails",
        code: `
          async function triggerScan() {
            const result = await fetch("https://engine.example.com/answer");
            return result;
          }
        `,
        errors: [{ messageId: "bannedFetchCall" }],
      },
    ],
  });
});
