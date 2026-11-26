/**
 * Words as history search compares them. A token (a run of letters and
 * digits) is split into parts at camelCase humps, runs of capitals and
 * digits, so "getElementById" is get, element, by, id and "XMLHttpRequest"
 * is xml, http, request. Parts are lowercased with JavaScript's full Unicode
 * folding, on both the indexed text and the query, so the two always agree.
 *
 * A query word matches when its parts appear in that order, whole, with an
 * English ending allowed on the last one: "fix" finds "fixed" and "fixes",
 * "loadConfig" finds "getLoadConfig", and "not" finds neither "nothing" nor
 * "note". FTS5 trigrams and LIKE only find candidates: they match inside
 * words ("fix" in "prefix").
 */

const TOKEN = /[\p{L}\p{M}\p{N}]+/gu;
// A run of capitals before a capitalized word (XML in XMLParser), a
// capitalized or lowercase word, a run of capitals, digits, or letters
// without case (CJK)
const PART =
  /\p{Lu}+(?=\p{Lu}[\p{Ll}\p{M}])|\p{Lu}?[\p{Ll}\p{M}]+|\p{Lu}+|\p{N}+|[^\p{Lu}\p{Ll}\p{M}\p{N}]+/gu;

/** The lowercase parts of a token */
function parts(token: string): string[] {
  return (token.match(PART) ?? []).map((part) => part.toLowerCase());
}

/** Each part of a text, with where its token starts and ends */
function partsWithOffsets(
  text: string,
): { part: string; start: number; end: number }[] {
  const found: { part: string; start: number; end: number }[] = [];
  for (const token of text.matchAll(TOKEN)) {
    const end = token.index + token[0].length;
    for (const part of parts(token[0])) {
      found.push({ part, start: token.index, end });
    }
  }
  return found;
}

/**
 * The words of a text as the index stores them, between spaces: every part
 * in order, then each token of several parts whole, lowercased, so a query
 * that writes an identifier in one piece ("getelementbyid") matches too.
 */
export function indexWords(text: string): string {
  const all: string[] = [];
  const whole: string[] = [];
  for (const token of text.match(TOKEN) ?? []) {
    const split = parts(token);
    all.push(...split);
    if (split.length > 1) {
      whole.push(token.toLowerCase());
    }
  }
  // The bar keeps a query's parts from running from the parts into the
  // whole tokens
  return ` ${all.join(" ")} | ${whole.join(" ")} `;
}

const SIBILANT = /(?:s|x|z|ch|sh)$/;
// A short word whose last consonant doubles before an ending (stop,
// stopped), but not w, x or y
const DOUBLES = /^[^aeiou]*[aeiou][b-df-hj-np-tvz]$/;

/**
 * The forms a query's last part may take in the text: itself and its common
 * English endings, from its stem when it already has one. Parts under 3
 * characters and numbers match only as written.
 */
export function wordForms(word: string): string[] {
  if (word.length < 3 || /^\p{N}+$/u.test(word)) {
    return [word];
  }
  const stems = new Set([word]);
  const add = (stem: string) => {
    if (stem.length >= 3) {
      stems.add(stem);
    }
  };
  if (word.endsWith("ing")) {
    const stem = word.slice(0, -3);
    add(stem);
    add(`${stem}e`);
    if (/(.)\1$/.test(stem)) {
      add(stem.slice(0, -1));
    }
  } else if (word.endsWith("ed")) {
    const stem = word.slice(0, -2);
    add(stem);
    add(word.slice(0, -1));
    if (/(.)\1$/.test(stem)) {
      add(stem.slice(0, -1));
    }
  } else if (word.endsWith("es") && SIBILANT.test(word.slice(0, -2))) {
    add(word.slice(0, -2));
  } else if (word.endsWith("s") && !word.endsWith("ss")) {
    add(word.slice(0, -1));
  }
  const forms = new Set<string>();
  for (const stem of stems) {
    forms.add(stem);
    forms.add(SIBILANT.test(stem) ? `${stem}es` : `${stem}s`);
    const base = stem.endsWith("e") ? stem.slice(0, -1) : stem;
    const doubled = DOUBLES.test(stem) ? stem + stem.slice(-1) : base;
    forms.add(stem.endsWith("e") ? `${stem}d` : `${doubled}ed`);
    forms.add(`${doubled}ing`);
  }
  return [...forms];
}

export interface SearchWord {
  /** The parts before the last, which must match exactly */
  lead: string[];
  /** The forms the last part may take */
  forms: string[];
}

/** A query word split as the index splits text; undefined when it has none */
export function searchWord(term: string): SearchWord | undefined {
  const split = (term.match(TOKEN) ?? []).flatMap(parts);
  if (!split.length) {
    return undefined;
  }
  return {
    lead: split.slice(0, -1),
    forms: wordForms(split[split.length - 1]),
  };
}

/** LIKE patterns over indexWords() output: any one of them is a match */
export function likePatterns(word: SearchWord): string[] {
  // Parts are letters and digits only, so nothing needs escaping
  return word.forms.map((form) => `% ${[...word.lead, form].join(" ")} %`);
}

/**
 * Text every match contains, for FTS5 to find candidates: each part of 3 or
 * more characters, and the start the last part's forms share
 */
export function candidateText(word: SearchWord): string[] {
  let shared = word.forms[0];
  for (const form of word.forms) {
    while (!form.startsWith(shared)) {
      shared = shared.slice(0, -1);
    }
  }
  return [...word.lead, shared].filter((part) => part.length >= 3);
}

/** The tokens where the earliest of `words` matches in `text`, if any */
export function findWord(
  text: string,
  words: SearchWord[],
): { start: number; end: number } | undefined {
  const found = partsWithOffsets(text);
  for (let i = 0; i < found.length; i++) {
    for (const word of words) {
      const all = word.lead.length + 1;
      if (i + all > found.length) {
        continue;
      }
      const leads = word.lead.every((lead, j) => found[i + j].part === lead);
      if (leads && word.forms.includes(found[i + all - 1].part)) {
        return { start: found[i].start, end: found[i + all - 1].end };
      }
    }
  }
  return undefined;
}
