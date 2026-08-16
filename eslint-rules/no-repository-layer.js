// STORY-022 — coding-standards.md §1, NFR-ARCH-09: "No repository interface,
// command bus, or mapper layer between a service and Drizzle." Scoped (in
// eslint.config.js's `files`) to src/modules/** — services in that tree call
// Drizzle directly; this rule is what makes "the default answer is no" to a
// repository/CQRS layer enforceable rather than a review opinion.

const REPOSITORY_OR_MAPPER_SUFFIX = /(Repository|Mapper)$/;
const BANNED_CQRS_IMPORT_NAMES = new Set(["CommandBus", "QueryBus", "EventBus", "ICommand", "IQuery", "IEvent"]);
const BANNED_CQRS_MODULE_PATTERN = /cqrs/i;

function checkNamedTypeDeclaration(context, node, name) {
  if (typeof name === "string" && REPOSITORY_OR_MAPPER_SUFFIX.test(name)) {
    context.report({ node, messageId: "repositoryOrMapperType", data: { name } });
  }
}

/** @type {import('eslint').Rule.RuleModule} */
const noRepositoryLayer = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Bans a repository interface, a command bus, or a mapper layer between a service and Drizzle. NFR-ARCH-09 — the default answer to introducing one is no; it requires an ADR.",
    },
    schema: [],
    messages: {
      repositoryOrMapperType:
        "'{{name}}' looks like a repository/mapper abstraction over Drizzle — services call Drizzle directly (NFR-ARCH-09). An ADR is required to introduce this layer.",
      cqrsImport:
        "'{{name}}' is CQRS command/query/event-bus vocabulary — this codebase does not use CQRS (NFR-ARCH-09, coding-standards.md §1). An ADR is required to introduce it.",
      cqrsModule:
        "Importing from '{{source}}' pulls in a CQRS package — this codebase does not use CQRS (NFR-ARCH-09). An ADR is required to introduce it.",
    },
  },
  create(context) {
    return {
      ClassDeclaration(node) {
        checkNamedTypeDeclaration(context, node, node.id && node.id.name);
      },
      "TSInterfaceDeclaration"(node) {
        checkNamedTypeDeclaration(context, node, node.id && node.id.name);
      },
      "TSTypeAliasDeclaration"(node) {
        checkNamedTypeDeclaration(context, node, node.id && node.id.name);
      },
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source === "string" && BANNED_CQRS_MODULE_PATTERN.test(source)) {
          context.report({ node, messageId: "cqrsModule", data: { source } });
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            const importedName =
              specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
            if (BANNED_CQRS_IMPORT_NAMES.has(importedName)) {
              context.report({ node: specifier, messageId: "cqrsImport", data: { name: importedName } });
            }
          }
        }
      },
    };
  },
};

export default noRepositoryLayer;
