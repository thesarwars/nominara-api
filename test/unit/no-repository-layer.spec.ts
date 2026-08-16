import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
// @ts-expect-error — plain JS rule module, no type declarations.
import noRepositoryLayer from "../../eslint-rules/no-repository-layer.js";

// STORY-022 scenario 5 — "Add a repository interface over the data layer →
// Lint fails." Needs the TS parser (unlike no-session-scoped-config and
// no-request-handler-network-call) because `interface`/`type` declarations
// are TypeScript-only AST nodes that espree cannot parse at all.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("STORY-022 · eslint-rules/no-repository-layer", () => {
  ruleTester.run("no-repository-layer", noRepositoryLayer, {
    valid: [
      {
        name: "a plain service calling Drizzle directly is permitted",
        code: `
          class ProjectsService {
            async listProjects() {
              return this.db.tx().select().from(projects);
            }
          }
        `,
      },
      { name: "a DTO type is permitted", code: `type CreateProjectRequest = { rootUrl: string };` },
      { name: "importing rxjs is unrelated to CQRS", code: `import { from } from "rxjs";` },
    ],
    invalid: [
      {
        name: "a *Repository interface over the data layer is a deliberate violation — lint fails",
        code: `interface ProjectsRepository { findById(id: string): Promise<unknown>; }`,
        errors: [{ messageId: "repositoryOrMapperType" }],
      },
      {
        name: "a *Repository class is a deliberate violation — lint fails",
        code: `class ProjectsRepository { findById(id) { return null; } }`,
        errors: [{ messageId: "repositoryOrMapperType" }],
      },
      {
        name: "a *Mapper type alias is a deliberate violation — lint fails",
        code: `type ProjectMapper = (row: unknown) => unknown;`,
        errors: [{ messageId: "repositoryOrMapperType" }],
      },
      {
        name: "importing CommandBus is a deliberate CQRS violation — lint fails",
        code: `import { CommandBus } from "@nestjs/cqrs";`,
        errors: [{ messageId: "cqrsModule" }],
      },
    ],
  });
});
