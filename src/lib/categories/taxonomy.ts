import type { ClientBase } from "pg";
import type { CategoryDescriptor } from "./classify.js";
import type { CategoryPeer } from "./peers.js";

// STORY-189 — reads of the two GLOBAL, read-only tables (`business_categories`, `category_peers`). They carry no workspace_id and no RLS, so
// there is no tenant predicate to add: every runtime role may read them and none may write them (migrations 0187-0188, decision 91).
// Raw SQL on a plain client, like the other src/lib readers; callers pass the ambient tenant transaction.

/** Every category, in slug order. */
export async function loadTaxonomy(client: Pick<ClientBase, "query">): Promise<CategoryDescriptor[]> {
  const result = await client.query<CategoryDescriptor>("SELECT slug, name, description FROM business_categories ORDER BY slug");
  return result.rows;
}

/** The curated peers of one category, by name. Empty for an unknown category and for the eleven local-market ones. */
export async function loadCategoryPeers(client: Pick<ClientBase, "query">, categorySlug: string): Promise<CategoryPeer[]> {
  const result = await client.query<CategoryPeer>(
    "SELECT name, root_domain FROM category_peers WHERE category_slug = $1 ORDER BY name, root_domain",
    [categorySlug],
  );
  return result.rows;
}

/** Whether `slug` is one of the seeded categories. */
export async function categoryExists(client: Pick<ClientBase, "query">, slug: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM business_categories WHERE slug = $1", [slug]);
  return (result.rowCount ?? result.rows.length) > 0;
}
