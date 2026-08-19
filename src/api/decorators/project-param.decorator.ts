import { SetMetadata } from "@nestjs/common";

// STORY-019 — names the route param holding the project id a "scoped"
// permission is checked against (e.g. @ProjectParam("projectId") on a route
// like GET /projects/:projectId). RbacGuard reads this via Reflector and
// looks the value up on req.params — same SetMetadata pattern as
// @Public()/@SkipTenantContext(), not a runtime param decorator.
export const PROJECT_PARAM_KEY = "projectParam";
export const ProjectParam = (paramName: string): MethodDecorator & ClassDecorator =>
  SetMetadata(PROJECT_PARAM_KEY, paramName);
