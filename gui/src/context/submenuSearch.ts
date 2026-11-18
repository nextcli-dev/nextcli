import type { ContextSubmenuItemWithProvider } from "core";
import { deduplicateArray, splitCamelCaseAndNonAlphaNumeric } from "core/util";
import MiniSearch, { SearchOptions } from "minisearch";

export const MINISEARCH_OPTIONS: SearchOptions = {
  prefix: true,
  fuzzy: 2,
};

/** The index the @ dropdown searches for one submenu context provider */
export function createSubmenuMiniSearch(
  items: ContextSubmenuItemWithProvider[],
): MiniSearch<ContextSubmenuItemWithProvider> {
  const minisearch = new MiniSearch<ContextSubmenuItemWithProvider>({
    fields: ["title", "description"],
    storeFields: ["id", "title", "description", "providerTitle"],
    tokenize: (text) =>
      deduplicateArray(
        MiniSearch.getDefault("tokenize")(text).concat(
          splitCamelCaseAndNonAlphaNumeric(text),
        ),
        (a, b) => a === b,
      ),
  });
  minisearch.addAll(deduplicateArray(items, (a, b) => a.id === b.id));
  return minisearch;
}

interface RankableResult {
  id: string;
  title: string;
  description: string;
  score: number;
}

/** Lowercase letters and digits only: "AGENTS.md", "agents md" and "agentsmd" compare equal */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const FUZZY_ONLY = 6;

/**
  How well a file's name and path match the query (trimmed and lowercased,
  and its normalized form), lower is better:
  1 the name, the name without its extension or the normalized name is the query
  2 the name starts with the query
  3 a word of the name (split on punctuation and camelCase) starts with the query
  4 the name contains the query
  5 the path contains the query
  6 anything else, i.e. a fuzzy match only
*/
function matchTier(result: RankableResult, q: string, nq: string): number {
  if (!q) {
    return FUZZY_ONLY;
  }
  const name = result.title.toLowerCase();
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const normalizedName = normalize(name);

  if (name === q || stem === q || (nq && normalizedName === nq)) {
    return 1;
  }
  if (name.startsWith(q) || (nq && normalizedName.startsWith(nq))) {
    return 2;
  }
  if (
    splitCamelCaseAndNonAlphaNumeric(result.title).some((word) =>
      word.startsWith(q),
    )
  ) {
    return 3;
  }
  if (name.includes(q) || (nq && normalizedName.includes(nq))) {
    return 4;
  }
  const path = result.description.toLowerCase();
  if (path.includes(q) || (nq && normalize(path).includes(nq))) {
    return 5;
  }
  return FUZZY_ONLY;
}

/**
  Sorts file search results by how well the name matches the query. Within
  the same match, open files come first, then shorter names, then the
  MiniSearch score, then shorter paths; among fuzzy-only matches the score
  comes before the name length. The file type and folder don't count.
*/
export function rankFileSearchResults<T extends RankableResult>(
  results: T[],
  query: string,
  openFileIds: ReadonlySet<string>,
): T[] {
  const q = query.trim().toLowerCase();
  const nq = normalize(q);
  return results
    .map((result) => ({
      result,
      tier: matchTier(result, q, nq),
      open: openFileIds.has(result.id),
    }))
    .sort((a, b) => {
      const byLength = a.result.title.length - b.result.title.length;
      const byScore = b.result.score - a.result.score;
      return (
        a.tier - b.tier ||
        Number(b.open) - Number(a.open) ||
        (a.tier === FUZZY_ONLY ? byScore || byLength : byLength || byScore) ||
        a.result.description.length - b.result.description.length
      );
    })
    .map(({ result }) => result);
}
