import type { LicensedAnswer, LicensedElement, LicensedLink, LicensedProduct, LicensedReference } from "./licensed-serp.js";
import type { SerpAnswerBody, SerpShoppingResult, SerpTextBlock } from "./serp-response.schema.js";

// STORY-029 AC1 - THE ONE MAPPER BOTH SURFACES SHARE. AI Mode returns its answer at the top level of the response and an AI Overview
// returns it inside `ai_overview`, but the body underneath is the same `text_blocks` + `references` (serpapi.com/google-ai-mode-api,
// /google-ai-overview-api), so there is exactly one function from that body to the provider-neutral LicensedAnswer. This file is the
// ONLY vendor-specific response mapping; a fallback provider ships its own `mapXAnswer` and nothing downstream changes.
//
// The vendor's element has no engine, surface or model field, and nothing here reads one: the engine key is stamped by the adapter
// from the endpoint it called.

/** A vendor UI string that glues itself to a product name in table cells ("...by AnkerGo to product viewer dialog..."). Left in, it breaks the word boundary a mention match needs. */
const VIEWER_BOILERPLATE = /\s*Go to product viewer dialog for this item\.?/giu;

function clean(text: string): string {
  return text.replace(VIEWER_BOILERPLATE, "").trim();
}

function referencesOf(body: SerpAnswerBody): LicensedReference[] {
  return (body.references ?? [])
    .map((reference) => ({
      index: reference.index,
      url: reference.link,
      ...(reference.title !== undefined ? { title: reference.title } : {}),
      ...(reference.snippet !== undefined ? { snippet: reference.snippet } : {}),
    }))
    .sort((a, b) => a.index - b.index);
}

function productOf(result: SerpShoppingResult): LicensedProduct {
  return {
    ...(result.title !== undefined ? { title: result.title } : {}),
    ...(result.price !== undefined ? { price: result.price } : {}),
    ...(result.rating !== undefined ? { rating: result.rating } : {}),
    ...(result.reviews !== undefined ? { reviewCount: result.reviews } : {}),
    ...(result.thumbnail !== undefined ? { image: result.thumbnail } : {}),
    ...(result.product_link !== undefined ? { link: result.product_link } : {}),
  };
}

function productLine(product: LicensedProduct): string {
  return [product.title, product.price].filter((part) => part !== undefined && part !== "").join(" - ");
}

function tableMarkdown(rows: readonly (readonly string[])[]): string {
  const cleaned = rows.map((row) => row.map(clean));
  const [header, ...body] = cleaned;
  if (header === undefined) return "";
  const line = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...body.map(line)].join("\n");
}

export function mapSerpAnswer(body: SerpAnswerBody): LicensedAnswer {
  const references = referencesOf(body);
  const byIndex = new Map(references.map((reference) => [reference.index, reference]));
  const elements: LicensedElement[] = [];
  const markdown: string[] = [];
  const seenProducts = new Set<string>();

  /** An element's own references (`reference_indexes`), resolved to links, in the vendor's order, without repeats. A dangling index is dropped, never invented. */
  const linksOf = (block: SerpTextBlock): LicensedLink[] => {
    const links: LicensedLink[] = [];
    for (const index of block.reference_indexes ?? []) {
      const reference = byIndex.get(index);
      if (reference === undefined || links.some((link) => link.url === reference.url)) continue;
      links.push({ url: reference.url, ...(reference.title !== undefined ? { title: reference.title } : {}) });
    }
    return links;
  };

  const addProduct = (result: SerpShoppingResult, links: LicensedLink[]): string => {
    const product = productOf(result);
    if (product.title !== undefined) seenProducts.add(product.title);
    elements.push({ kind: "product", text: productLine(product), links, product });
    return productLine(product);
  };

  const walkItem = (item: SerpTextBlock, depth: number): void => {
    const indent = "  ".repeat(depth);
    const links = linksOf(item);
    if (item.shopping_result !== undefined) {
      markdown.push(`${indent}- ${addProduct(item.shopping_result, links)}`);
    } else {
      const text = clean([item.title, item.snippet].filter((part) => part !== undefined && part !== "").join(": "));
      if (text !== "") {
        markdown.push(`${indent}- ${text}`);
        elements.push({ kind: "text", text, links });
      }
    }
    for (const nested of item.list ?? []) walkItem(nested, depth + 1);
    walkBlocks(item.text_blocks ?? []);
  };

  const walkBlocks = (blocks: readonly SerpTextBlock[]): void => {
    for (const block of blocks) {
      const links = linksOf(block);
      switch (block.type) {
        case "heading": {
          const text = clean(block.snippet ?? "");
          if (text === "") break;
          markdown.push(`\n### ${text}\n`);
          elements.push({ kind: "text", text, links });
          break;
        }
        case "list":
          for (const item of block.list ?? []) walkItem(item, 0);
          markdown.push("");
          break;
        case "expandable": {
          const title = clean(block.title ?? "");
          if (title !== "") {
            markdown.push(`\n#### ${title}\n`);
            elements.push({ kind: "text", text: title, links });
          }
          walkBlocks(block.text_blocks ?? []);
          break;
        }
        case "table": {
          const text = tableMarkdown(block.table ?? []);
          if (text === "") break;
          markdown.push(`${text}\n`);
          elements.push({ kind: "table", text, links });
          break;
        }
        case "comparison": {
          const labels = block.product_labels ?? [];
          const rows = (block.comparison ?? []).map((row) => [row.feature ?? "", ...(row.values ?? [])]);
          const text = tableMarkdown([["Feature", ...labels], ...rows]);
          const spec = Object.fromEntries((block.comparison ?? []).filter((row) => row.feature !== undefined).map((row) => [row.feature as string, (row.values ?? []).join(" | ")]));
          markdown.push(`${text}\n`);
          elements.push({ kind: "table", text, links, spec });
          break;
        }
        default: {
          // paragraph, code_block and any block type the vendor adds later: keep its words rather than dropping content silently.
          const text = clean(block.snippet ?? "");
          if (text === "") break;
          markdown.push(`${text}\n`);
          elements.push({ kind: "text", text, links });
        }
      }
    }
  };

  walkBlocks(body.text_blocks);

  // The top-level shopping_results repeat the products the list items already carry; only a product seen nowhere else is added.
  for (const result of body.shopping_results ?? []) {
    if (result.title !== undefined && seenProducts.has(result.title)) continue;
    addProduct(result, []);
  }

  return { markdown: markdown.join("\n").replace(/\n{3,}/gu, "\n\n").trim(), elements, references };
}
