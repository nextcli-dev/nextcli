const DEFAULT_MAX_CHARS = 4_000_000;
const DEFAULT_MIN_CHARS = 512;

/**
 * LRU cache keyed by the text itself, bounded by total characters.
 * Texts shorter than `minChars`, and a single text longer than `maxChars`,
 * are counted directly.
 */
export function memoizeCount(
  count: (text: string) => number,
  options?: { maxChars?: number; minChars?: number },
): (text: string) => number {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const minChars = options?.minChars ?? DEFAULT_MIN_CHARS;
  const cache = new Map<string, number>();
  let cachedChars = 0;

  return (text: string) => {
    if (text.length < minChars || text.length > maxChars) {
      return count(text);
    }

    const hit = cache.get(text);
    if (hit !== undefined) {
      cache.delete(text);
      cache.set(text, hit);
      return hit;
    }

    const tokens = count(text);
    cache.set(text, tokens);
    cachedChars += text.length;
    while (cachedChars > maxChars) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cachedChars -= oldest.length;
      cache.delete(oldest);
    }
    return tokens;
  };
}
