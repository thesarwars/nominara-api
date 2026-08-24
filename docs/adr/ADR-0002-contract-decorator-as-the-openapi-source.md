# ADR-0002 — The `@ApiContract()` decorator, not a `contracts/registry.ts`, is the OpenAPI source

**Status:** Accepted

## Context

STORY-023 (task T1) needs a way to attach the request, response, and
error zod schemas that already validate a route to that same route, so a
later generator (task T3) can walk every route and produce
`openapi.generated.json` with nothing hand-maintained in between —
`NFR-REPO-01` (`project-structure.md` §7): "The OpenAPI document is a
build artifact of `nominara-api`, generated from the zod schemas. Drift
between the schemas and the committed document fails the API build."

Two shapes were considered for how the generator finds a route's schemas:

- **A `contracts/registry.ts`** — a hand-maintained table mapping each
  route to its schemas, independent of the controller.
- **A decorator on the route itself**, read by the generator via
  `DiscoveryService` (or an equivalent Nest-container walk).

A registry's failure mode is "the registry forgot a route": a controller
method exists, is wired into a module, and works, but nobody added its
row to the table, so it is silently absent from the generated document. A
decorator's failure mode is "the route forgot its decorator" — the same
silent absence, by the mirror-image mistake. Neither shape is
self-checking on its own: the drift check (`contracts:check`) compares
the generated document against the committed one and passes as long as
generation is deterministic, because a route missing its decorator (or
its registry row) simply generates the same, consistently-incomplete
document every time. **This is why a route-coverage gate is mandatory
alongside whichever shape is chosen** — task T2's coverage gate, which
must fail on an undecorated route before task T3 gives the decorator
anything to attach to, is not optional hardening; it is what catches the
failure mode this ADR cannot design away.

A decorator was still chosen over a registry, because it keeps the
schema reference physically next to the route it validates (the same
locality the codebase already uses for `@Public()`, `@RequirePermission()`,
and `@Audit()`), rather than introducing a second file a reviewer must
remember to update in lockstep with the controller — the exact
drift-by-two-descriptions failure this story's drift check exists to
prevent, just moved one level up from "schema vs. document" to
"controller vs. registry".

### The `@nestjs/swagger` boundary

A decorator that reads like Swagger's — `@ApiOperation()`, `@ApiResponse()`
with inline field descriptions, examples, and types — is an on-ramp to
adopting `@nestjs/swagger` itself, which would make decorator metadata a
**second** description of the contract alongside zod and break KAD-05
(contracts precede and are the single source, never duplicated). This
ADR records: the `@ApiContract()` decorator carries **references to zod
schemas only** — an operation identity plus the request, response, and
error schema objects themselves — never a duplicated field description,
example, or type. `@nestjs/swagger` is **not** adopted; there is no new
dependency here.

## Decision

`@ApiContract()` (`src/api/decorators/api-contract.decorator.ts`) is the
OpenAPI source for task T3's generator. `contracts/registry.ts` is **not**
introduced. The decorator's metadata is exactly:

- `operationId` — a stable per-route identity, used as the generated
  document's `operationId` and the drift fingerprint's key.
- `requestSchema` — a reference to the route's request zod schema
  (absent on a route with no request body).
- `responseSchema` — a reference to the route's response zod schema.
- `errorSchema` — a reference to any error shape beyond the shared
  `problemDetailsSchema` (absent otherwise).

No field description, example, or type is ever written into the
decorator call. Everything the generated document says about a field
comes from walking the referenced schema, never from a string literal at
the call site.

## Consequences

- **`contracts:generate` stops being a pure file transform.** Reading a
  decorator's metadata off a live route means the generator must either
  boot the Nest container or walk route metadata via `DiscoveryService` —
  it can no longer just read `.schema.ts` files off disk and emit JSON.
- It therefore needs a valid runtime environment (whatever the
  application's bootstrap needs) and is materially slower than a file
  transform would have been.
- **If the application cannot boot, the document cannot be generated at
  all.** A boot failure and a contract-generation failure become the same
  red build. This is accepted as the cost of making route-to-schema
  divergence structurally impossible: the alternative (a registry, or a
  decorator read by static analysis instead of a live discovery walk)
  reintroduces a path where the generated document can silently
  disagree with what a route actually validates at runtime.
- Task T2's route-coverage gate is not optional given this decision — see
  Context above. It is what turns "the route forgot its decorator" into a
  build failure instead of a silently incomplete document.
