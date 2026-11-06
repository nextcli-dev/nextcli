import { describe, expect, it } from "vitest";

import golden from "../../../test/fixtures/regression/adf/golden.json";
import { adfToMarkdown } from "./adfToMarkdown";

interface GoldenCase {
  name: string;
  input: unknown;
  output?: string;
  error?: string;
}

// Where the replacement deliberately differs from adf-to-md 1.2.1's output.
// Every other golden case must match byte for byte.
const INTENTIONAL_DIFFERENCES: Record<
  string,
  { expected: string; why: string }
> = {
  "nested lists": {
    expected: "  * parent\n    1. child one\n    2. child two\n  * sibling",
    why: "adf-to-md glued the child list onto the parent's line",
  },
  "list item with two paragraphs": {
    expected: "  * first para\n    second para",
    why: "adf-to-md joined the paragraphs into one line",
  },
  "code block with empty attrs": {
    expected: "```\nattrs but no language\n```",
    why: 'adf-to-md printed the language as "undefined"',
  },
  "rule between paragraphs": {
    expected: "above\n\n---\n\nbelow",
    why: "adf-to-md surrounded the rule with extra blank lines",
  },
  "mention (unsupported)": {
    expected: "Ping @Ann Lee please",
    why: "adf-to-md dropped mentions",
  },
  "table with header row": {
    expected: "|Name|Status|\n|:-:|:-:|\n|parser|**done**|\n|lexer||",
    why: "no trailing newline: the whole document is trimmed",
  },
  "table without header": {
    expected: "|a|b|",
    why: "no trailing newline: the whole document is trimmed",
  },
  "panel (unsupported)": {
    expected: "> Heads up: this is in a panel.",
    why: "adf-to-md dropped panels and their text",
  },
  "status, date, expand (unsupported)": {
    expected: "[IN PROGRESS] since 2025-11-05\n\n**Details**\n\nhidden text",
    why: "adf-to-md dropped status, date and expand content",
  },
  "task list (unsupported)": {
    expected: "  * [x] write tests",
    why: "adf-to-md dropped task lists",
  },
  "invalid: missing version": {
    expected: "x",
    why: "convert what we can; one malformed field must not fail the issue",
  },
  "invalid: wrong root type": {
    expected: "x",
    why: "convert what we can; one malformed field must not fail the issue",
  },
};

const cases = (golden as { cases: GoldenCase[] }).cases;

describe("adfToMarkdown against the adf-to-md golden output", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const difference = INTENTIONAL_DIFFERENCES[c.name];
    const expected = difference ? difference.expected : c.output;
    expect(expected).toBeTypeOf("string");
    expect(adfToMarkdown(c.input)).toBe(expected);
  });

  it("lists only differences for cases that exist", () => {
    const names = new Set(cases.map((c) => c.name));
    expect(
      Object.keys(INTENTIONAL_DIFFERENCES).filter((n) => !names.has(n)),
    ).toEqual([]);
  });
});

describe("adfToMarkdown edge cases", () => {
  const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
  const p = (text: string) => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  });
  const item = (...content: unknown[]) => ({ type: "listItem", content });

  it.each([null, undefined, "text", 42, {}, { content: [] }])(
    "returns an empty string for %j",
    (input) => {
      expect(adfToMarkdown(input)).toBe("");
    },
  );

  it("indents three levels of nested lists", () => {
    const list = doc({
      type: "bulletList",
      content: [
        item(p("a"), {
          type: "bulletList",
          content: [
            item(p("b"), { type: "orderedList", content: [item(p("c"))] }),
          ],
        }),
      ],
    });
    expect(adfToMarkdown(list)).toBe("  * a\n    * b\n      1. c");
  });

  it("indents a code block inside a list item", () => {
    const list = doc({
      type: "bulletList",
      content: [
        item(p("run:"), {
          type: "codeBlock",
          content: [{ type: "text", text: "npm test" }],
        }),
      ],
    });
    expect(adfToMarkdown(list)).toBe(
      "  * run:\n    ```\n    npm test\n    ```",
    );
  });

  it("escapes pipes and flattens line breaks in table cells", () => {
    const table = doc({
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "a|b" },
                    { type: "hardBreak" },
                    { type: "text", text: "c" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(adfToMarkdown(table)).toBe("|a\\|b c|");
  });

  it("renders the text of unknown nodes instead of dropping them", () => {
    const unknown = doc({
      type: "someFutureBlock",
      content: [p("still here")],
    });
    expect(adfToMarkdown(unknown)).toBe("still here");
  });

  it("falls back to @unknown for a mention without text", () => {
    const mention = doc({
      type: "paragraph",
      content: [{ type: "mention", attrs: { id: "abc" } }],
    });
    expect(adfToMarkdown(mention)).toBe("@unknown");
  });
});
