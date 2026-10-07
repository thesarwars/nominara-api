import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import {
  renameTopicRequestSchema,
  topicListResponseSchema,
  topicSchema,
  type RenameTopicRequest,
  type Topic,
  type TopicListResponse,
} from "../../../contracts/projects/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { TopicsService } from "./topics.service.js";

// NEW-B-3 — api-specification.md §3: `GET /projects/{id}/topics` is
// `tracking:read`, `PATCH /topics/{id}` is `prompt:write`. Both permissions
// are `scoped` for a manager, so each route says how scope is checked.
@Controller()
export class TopicsController {
  constructor(private readonly topics: TopicsService) {}

  // The path names the project, so `@ProjectParam` lets the guard compare it
  // to the member's scope.
  @Get("projects/:id/topics")
  @ProjectParam("id")
  @RequirePermission("tracking:read")
  @ApiContract({ operationId: "listTopics", responseSchema: topicListResponseSchema })
  list(@Param("id") projectId: string): Promise<TopicListResponse> {
    return this.topics.list(projectId);
  }

  // The path names a TOPIC, so the project is only known after the row is
  // read. `@ScopedByQuery` admits a non-empty scope past the guard (a
  // zero-project scope is still refused there) and the service compares the
  // row's project to the scope and raises 403 when it is outside.
  @Patch("topics/:id")
  @ScopedByQuery()
  @RequirePermission("prompt:write")
  @Audit({ action: "topic.renamed", resourceType: "topic" })
  @ApiContract({
    operationId: "renameTopic",
    requestSchema: renameTopicRequestSchema,
    responseSchema: topicSchema,
  })
  rename(
    @Param("id") topicId: string,
    @Body(new ZodValidationPipe(renameTopicRequestSchema)) body: RenameTopicRequest,
  ): Promise<Topic> {
    return this.topics.rename(topicId, body);
  }
}
