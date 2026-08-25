import type { PaginationResponse } from "../../../contracts/common/pagination.schema.js";
import { encodeCursor, type CursorKeyElement } from "./cursor.js";

// STORY-117 — the seam that lets a list handler return a page WITHOUT
// building an envelope. api-specification.md §1's envelope is assembled once,
// at the composition root (ResponseEnvelopeInterceptor); a controller that
// returned `{data, pagination, meta}` itself would be the hand-built envelope
// STORY-024 AC5 exists to rule out, and would drift from the interceptor the
// first time `meta` gained a member.
//
// So a handler returns THIS, and the interceptor splits it. The class is a
// marker as much as a container: `instanceof` is what the interceptor keys
// on, and a plain `{items, pagination}` object would be indistinguishable
// from a resource that happens to have those two fields.
//
// AuditInterceptor's "after" runs BEFORE this is unwrapped and reads `body.id`
// for `resourceIdFrom: "response"`. A Page has no `id`, so auditing a list
// route with that setting throws AuditResourceIdUnresolvedError rather than
// recording a wrong identifier. No list route is audited today; this makes
// the failure loud if one ever is.
export class Page<Item> {
  constructor(
    readonly items: readonly Item[],
    readonly pagination: PaginationResponse,
  ) {}
}

/**
 * Builds a Page from a keyset query that fetched ONE ROW MORE than the limit.
 *
 * The extra row is how `has_more` is known without a second COUNT query, and
 * counting is the wrong answer anyway: on a list with concurrent inserts a
 * count taken separately from the page is already stale when it arrives.
 *
 * `keyOf` must return the SAME tuple the query ordered by, in the same order.
 * A cursor keyed on anything else — or on a non-unique prefix of it — skips
 * and repeats rows across pages, which is the precise failure NFR-API-03
 * exists to prevent. That is why this takes the key extractor rather than
 * guessing at `row.id`.
 */
export function pageFrom<Row, Item>(
  rows: readonly Row[],
  limit: number,
  toItem: (row: Row) => Item,
  keyOf: (row: Row) => CursorKeyElement[],
): Page<Item> {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const last = visible[visible.length - 1];

  // `cursor_next` is null when there is no further page — never an empty
  // string, and never a cursor that would return zero rows. A client can
  // branch on the member itself rather than on `has_more`, and the two can
  // never disagree because both are derived here from the same fact.
  return new Page(
    visible.map(toItem),
    {
      cursor_next: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null,
      has_more: hasMore,
      limit,
    },
  );
}
