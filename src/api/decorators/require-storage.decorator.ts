import { SetMetadata } from "@nestjs/common";

// STORY-180 r6 - marks a route that cannot be served without object storage (the report export). StorageReadyGuard is GLOBAL and
// registered BEFORE QuotaGuard, and acts only on routes that carry this: a refusal for unconfigured storage must come before a
// `pdf_exports` unit is reserved, and a route-level @UseGuards guard runs after every global guard, so it cannot do that.
export const REQUIRE_STORAGE_KEY = "requireStorage";
export const RequireStorage = (): MethodDecorator & ClassDecorator => SetMetadata(REQUIRE_STORAGE_KEY, true);
