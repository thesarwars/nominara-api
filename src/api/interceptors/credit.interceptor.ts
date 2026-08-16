import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";

// STORY-022-E-2 — pass-through no-op. Real logic (commit the actual debit (<= reservation) or release on failure — CreditsModule, EPIC-10) lands in a
// future story. Composed now, in the corrected order (STORY-022 Technical
// Notes), so that future story is a logic change to an existing slot, never
// a refactor of the composition root. NestJS chains APP_INTERCEPTOR "before"
// logic in registration order and "after" logic in REVERSE registration
// order (RxJS pipe chaining) — this interceptor's registration position is
// itself load-bearing; see composition-root.spec.ts.
@Injectable()
export class CreditInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}
