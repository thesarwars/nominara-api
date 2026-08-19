import { SetMetadata } from "@nestjs/common";
import type { Permission } from "../../tenancy/permission-matrix.js";

// STORY-019 — declares the permission RbacGuard evaluates against the
// §6 matrix and the LIVE role from WorkspaceGuard (never the token's role
// claim). Same SetMetadata pattern as @Public()/@SkipTenantContext().
export const REQUIRE_PERMISSION_KEY = "requirePermission";
export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permission);
