import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import {
  fingerprintRequestSchema,
  fingerprintResponseSchema,
  type FingerprintRequest,
  type FingerprintResponse,
} from "../../../contracts/projects/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { RateLimitClass } from "../../api/rate-limit/route-class.js";
import { ProjectFingerprintService } from "./project-fingerprint.service.js";

// `POST /projects/fingerprint` (STORY-195, owner decision 87b) - pre-creation URL suggestions, 0 credits. Session-authenticated and TENANT-LESS: there
// is no project and no workspace row involved, and the route must not hold a transaction across its fetch (ADR-0003), so it carries no
// `@RequirePermission` (a tenant-less route may not: the invariant is in WorkspaceGuard). It reuses the `tool_site_files` rate class, the existing free
// "one fetch of a site's public surface" budget (60/hour per user, burst 10), rather than minting a class the reference does not list.
//
// It is a POST because it makes the server fetch a URL the caller names; it is not idempotency-keyed because it writes nothing.
@Controller("projects")
export class ProjectFingerprintController {
  constructor(private readonly service: ProjectFingerprintService) {}

  @Post("fingerprint")
  @HttpCode(200)
  @SkipTenantContext()
  @RateLimitClass("tool_site_files")
  @ApiContract({ operationId: "fingerprintProject", requestSchema: fingerprintRequestSchema, responseSchema: fingerprintResponseSchema })
  fingerprint(@Body(new ZodValidationPipe(fingerprintRequestSchema)) body: FingerprintRequest): Promise<FingerprintResponse> {
    return this.service.fingerprint(body);
  }
}
