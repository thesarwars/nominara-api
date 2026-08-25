import { SetMetadata } from "@nestjs/common";

// STORY-026 T23 — marks a route that writes its own response body.
//
// THE TRAP THIS EXISTS TO DESIGN OUT, WRITTEN DOWN BEFORE ANYONE HITS IT.
//
// A server-sent-events handler writes to `FastifyReply.raw` and returns
// nothing. Nest turns a handler's return value into an Observable, so a
// handler that returns `undefined` produces an observable that COMPLETES
// WITHOUT EMITTING. Three interceptors in this composition root then
// misbehave, and only one of the three is obvious:
//
//   TenantContextInterceptor  awaits `lastValueFrom(next.handle())` INSIDE
//                             `withTenantContext`. An observable that never
//                             emits makes `lastValueFrom` reject with
//                             `EmptyError` — so the transaction ROLLS BACK,
//                             on a request that succeeded. Holding a database
//                             transaction open for a sixty-second stream would
//                             be wrong even if it worked.
//   ResponseEnvelopeInterceptor  wraps `undefined` into `{data: null, meta}`
//                             and sends it, after the handler already wrote
//                             the stream — a JSON body appended to a
//                             `text/event-stream` response.
//   IdempotencyInterceptor    records that body as the replayable response.
//
// None of this manifests in EPIC-03, because the first streaming endpoint is
// STORY-079's. That is precisely why the exemption is built now: without it,
// STORY-079 inherits a transaction-rollback bug with no owner and no test
// pointing at it. Each of the three interceptors honours this marker, and each
// has a test asserting the skip.
//
// Method-only. A class-level application would exempt every route on a
// controller from the envelope and from tenant context, which is a much larger
// thing than "this one route streams".
export const STREAMING_KEY = "streaming";

export const Streaming = (): MethodDecorator => SetMetadata(STREAMING_KEY, true);
