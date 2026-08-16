import { SetMetadata } from "@nestjs/common";

// STORY-022 — marks a route as exempt from tenant-context enforcement.
// Health/readiness probes are the only routes using this today: they run
// unauthenticated (no JWT, no workspace), so WorkspaceGuard never populates
// req.tenant for them, and TenantContextInterceptor must not fail-close on
// that (E-3's fail-closed rule applies to every OTHER route).
export const IS_PUBLIC_KEY = "isPublic";
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
