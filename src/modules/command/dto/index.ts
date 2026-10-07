// STORY-085-A — DTOs are derived from the zod schemas in contracts/command/
// (coding-standards.md §2), never hand-written.
export {
  commandParseRequestSchema,
  type CommandParseRequest,
} from "../../../../contracts/command/parse-request.schema.js";
export {
  commandParseResponseSchema,
  type CommandParseResponse,
} from "../../../../contracts/command/parse-response.schema.js";
