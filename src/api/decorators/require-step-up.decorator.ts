import { SetMetadata } from "@nestjs/common";

// Owner decision 100(j) - a route-level step-up: RbacGuard requires a fresh strong authentication (the same window, closed edge, 401 `step_up_required`
// and `details.methods` as a permission the matrix marks step-up, e.g. export:data) AFTER the permission itself has been granted. It exists for a route
// whose PERMISSION cannot carry the step-up without changing every other route under it (billing:write also gates the plan change). The permission
// matrix is untouched.
export const REQUIRE_STEP_UP_KEY = "requireStepUp";
export const RequireStepUp = (): MethodDecorator => SetMetadata(REQUIRE_STEP_UP_KEY, true);
