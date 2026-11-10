import { Controller, Get, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { businessCategoriesResponseSchema, type BusinessCategoriesResponse } from "../../../contracts/projects/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { BusinessCategoriesService } from "./business-categories.service.js";

// `GET /business-categories` — the category override picker's list (STORY-189). Any member (`workspace:read`); the body is global, so it is cacheable per viewer.
@Controller("business-categories")
export class BusinessCategoriesController {
  constructor(private readonly categories: BusinessCategoriesService) {}

  @Get()
  @RequirePermission("workspace:read")
  @ApiContract({ operationId: "listBusinessCategories", responseSchema: businessCategoriesResponseSchema })
  async list(@Res({ passthrough: true }) reply: FastifyReply): Promise<BusinessCategoriesResponse> {
    reply.header("Cache-Control", "private, max-age=300");
    return this.categories.list();
  }
}
