import { parse, type ParseEntry } from "shell-quote";

/**
 * Characters after which a word starts, so a `#` there begins a comment:
 * bash's metacharacters only. `\s` would also take form feed, vertical tab
 * and Unicode spaces, which bash keeps inside a word.
 */
const WORD_START = /[ \t\n;&|()<>]/;

/**
 * Parses one line of shell with comments read the way bash reads them.
 * shell-quote starts a comment at any unquoted `#`, but bash only at the start
 * of a word, so `ls a#; rm -rf ~` would hide `rm -rf ~`. A `#` that
 * shell-quote takes for a comment inside a word is escaped and the line parsed
 * again. Throws when the comment can't be located, so callers fail closed.
 */
export function parseShellLine(
  line: string,
  env?: (key: string) => string,
): ParseEntry[] {
  let text = line;
  // Each pass escapes one more `#`, so a line can't need more passes than it
  // has characters
  for (let pass = 0; pass <= line.length; pass++) {
    // shell-quote's types take an env object or a function, not `undefined`
    const tokens = env ? parse(text, env) : parse(text);
    const last = tokens[tokens.length - 1];
    if (!last || typeof last !== "object" || !("comment" in last)) {
      return tokens;
    }
    // A comment runs to the end of the line
    const hash = text.length - last.comment.length - 1;
    if (text[hash] !== "#") {
      throw new Error("Can't locate the comment in a shell line");
    }
    // `ls a\ #` keeps the escaped space in the word, so `#` is literal there
    if (
      hash === 0 ||
      (WORD_START.test(text[hash - 1]) && !isEscaped(text, hash - 1))
    ) {
      return tokens;
    }
    text = `${text.slice(0, hash)}\\${text.slice(hash)}`;
  }
  throw new Error("Too many comments in a shell line");
}

/** Whether an odd run of backslashes escapes the character at `index` */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

/**
 * Whether a line uses `$'...'` or `$"..."` quoting, which shell-quote doesn't
 * read: `$'a\'#'` is one word to bash, so what follows it can't be split
 * reliably, and `$'\x72\x6d'` spells any command. Only an unquoted,
 * unescaped `$` starts one: in `grep 'foo$' x`, `echo "total $"` and
 * `echo \$'x'` the `$` is a plain character.
 */
export function hasDollarQuote(line: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    // A backslash escapes the next character, except inside single quotes
    if (char === "\\" && quote !== "'") {
      i++;
    } else if (quote) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "$" && (line[i + 1] === "'" || line[i + 1] === '"')) {
      return true;
    }
  }
  return false;
}
