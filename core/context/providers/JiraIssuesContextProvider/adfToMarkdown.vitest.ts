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
  "media (unsupported)": {
    expected: "[attachment]",
    why: "adf-to-md dropped attachments, so a screenshot-only description looked empty",
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

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const item = (...content: unknown[]) => ({ type: "listItem", content });
const code = (text: string, language?: string) => ({
  type: "codeBlock",
  ...(language === undefined ? {} : { attrs: { language } }),
  content: [{ type: "text", text }],
});

describe("code blocks", () => {
  it("keeps a fence at the list content column in a bullet list", () => {
    const list = doc({
      type: "bulletList",
      content: [item(p("run:"), code("npm test"))],
    });
    expect(adfToMarkdown(list)).toBe(
      "  * run:\n    ```\n    npm test\n    ```",
    );
  });

  it("keeps multi-line code intact in an ordered list, blank line empty", () => {
    const list = doc({
      type: "orderedList",
      content: [
        item(p("Run:"), code("def f():\n    return 1\n\nprint(f())", "python")),
      ],
    });
    // The content column of "  1. " is 5: the fence sits there, and removing
    // the list's 5 columns leaves the original code and its relative indent.
    expect(adfToMarkdown(list)).toBe(
      [
        "  1. Run:",
        "     ``` python",
        "     def f():",
        "         return 1",
        "",
        "     print(f())",
        "     ```",
      ].join("\n"),
    );
  });

  it("nests a list under an ordered item at its content column", () => {
    const list = doc({
      type: "orderedList",
      content: [
        item(p("parent"), { type: "bulletList", content: [item(p("child"))] }),
      ],
    });
    expect(adfToMarkdown(list)).toBe("  1. parent\n     * child");
  });

  it("uses a fence longer than any backtick run in the code", () => {
    expect(adfToMarkdown(doc(code("before\n```\nafter")))).toBe(
      "````\nbefore\n```\nafter\n````",
    );
    expect(adfToMarkdown(doc(code("a ```` b", "md")))).toBe(
      "````` md\na ```` b\n`````",
    );
  });

  it("keeps the language on one line", () => {
    expect(adfToMarkdown(doc(code("x", "py\nthon```\n# Comments")))).toBe(
      "``` python# Comments\nx\n```",
    );
  });
});

describe("lists", () => {
  it("keeps the parent marker when an item starts with a nested list", () => {
    const list = doc({
      type: "bulletList",
      content: [item({ type: "bulletList", content: [item(p("only child"))] })],
    });
    expect(adfToMarkdown(list)).toBe("  *\n    * only child");
  });

  it("keeps the marker of every item, including an empty one", () => {
    const list = doc({
      type: "orderedList",
      content: [item(p("a")), item(), item(p("c"))],
    });
    expect(adfToMarkdown(list)).toBe("  1. a\n  2.\n  3. c");
  });
});

describe("malformed input", () => {
  const text = (value: unknown, marks?: unknown) => ({
    type: "paragraph",
    content: [
      {
        type: "text",
        text: value,
        ...(marks === undefined ? {} : { marks }),
      },
    ],
  });

  it.each([
    ["a null mark", [null]],
    ["a non-object mark", ["strong", 7]],
    ["marks as an object", { type: "strong" }],
    ["marks as a string", "strong"],
    ["a mark with null attrs", [{ type: "link", attrs: null }]],
    ["a link without a string href", [{ type: "link", attrs: { href: 5 } }]],
  ])("keeps the text next to %s", (_name, marks) => {
    expect(adfToMarkdown(doc(text("kept", marks)))).toBe("kept");
  });

  it("still applies the valid marks next to a bad one", () => {
    expect(adfToMarkdown(doc(text("x", [null, { type: "strong" }, 3])))).toBe(
      "**x**",
    );
  });

  it("ignores non-string text and attrs, and out-of-range dates", () => {
    const bad = doc({
      type: "paragraph",
      content: [
        { type: "text", text: 42 },
        { type: "emoji", attrs: { shortName: { a: 1 } } },
        { type: "mention", attrs: { text: ["x"] } },
        { type: "status", attrs: { text: 1 } },
        { type: "date", attrs: { timestamp: "1e20" } },
        { type: "inlineCard", attrs: { url: {} } },
      ],
    });
    expect(adfToMarkdown(bad)).toBe("@unknown");
  });

  it("never throws on random garbage", () => {
    // Deterministic pseudo-random documents built from messy values.
    let seed = 1234567;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const types = [
      ...["doc", "paragraph", "text", "heading", "bulletList", "orderedList"],
      ...["listItem", "taskList", "taskItem", "codeBlock", "blockquote"],
      ...["panel", "table", "tableRow", "tableCell", "tableHeader", "media"],
      ...["mediaSingle", "mention", "emoji", "date", "status", "expand"],
      ...["unknown", 7, null, {}],
    ];
    const attrKeys = [
      ...["level", "order", "colspan", "rowspan", "language", "url", "href"],
      ...["text", "timestamp", "alt", "state"],
    ];
    const junk = [null, undefined, 0, -1, 1e20, "x", "```", [], {}, [null]];
    const pick = () => junk[rand(junk.length)];
    const make = (depth: number): unknown => {
      if (rand(12) === 0) {
        return pick();
      }
      return {
        type: types[rand(types.length)],
        text: pick(),
        attrs: rand(2)
          ? Object.fromEntries(attrKeys.map((k) => [k, pick()]))
          : pick(),
        marks: rand(2)
          ? [
              {
                type: ["strong", "link", "code", null][rand(4)],
                attrs: pick(),
              },
              pick(),
            ]
          : pick(),
        content:
          depth > 4 || !rand(3)
            ? pick()
            : Array.from({ length: rand(4) }, () => make(depth + 1)),
      };
    };
    for (let i = 0; i < 2000; i++) {
      const document = make(0);
      expect(
        () => adfToMarkdown(document),
        JSON.stringify(document),
      ).not.toThrow();
      expect(typeof adfToMarkdown(document)).toBe("string");
    }
  });

  it("falls back to the text if a document is nested too deeply", () => {
    let node: unknown = { type: "text", text: "deep" };
    for (let i = 0; i < 20000; i++) {
      node = { type: "blockquote", content: [node] };
    }
    expect(() => adfToMarkdown(doc(node))).not.toThrow();
  });
});

describe("attachments", () => {
  it("renders a screenshot-only description as a placeholder, not blank", () => {
    const shot = doc({
      type: "mediaSingle",
      attrs: { layout: "center" },
      content: [{ type: "media", attrs: { id: "m1", type: "file" } }],
    });
    expect(adfToMarkdown(shot)).toBe("[attachment]");
  });

  it("includes the alt text, and the caption of a mediaSingle", () => {
    const shot = doc({
      type: "mediaSingle",
      content: [
        { type: "media", attrs: { type: "file", alt: "login error.png" } },
        { type: "caption", content: [{ type: "text", text: "after login" }] },
      ],
    });
    expect(adfToMarkdown(shot)).toBe(
      "[attachment: login error.png]\nafter login",
    );
  });

  it("lists every file in a mediaGroup, and an inline file in text", () => {
    const group = doc(
      {
        type: "mediaGroup",
        content: [
          { type: "media", attrs: { alt: "a.log" } },
          { type: "media", attrs: { alt: "b.log" } },
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "see " },
          { type: "mediaInline", attrs: { alt: "c.txt" } },
        ],
      },
    );
    expect(adfToMarkdown(group)).toBe(
      "[attachment: a.log]\n[attachment: b.log]\n\nsee [attachment: c.txt]",
    );
  });
});

describe("merged table cells", () => {
  const cell = (
    type: string,
    text: string,
    attrs: Record<string, number> = {},
  ) => ({
    type,
    attrs,
    content: [
      { type: "paragraph", content: text ? [{ type: "text", text }] : [] },
    ],
  });
  const row = (...cells: unknown[]) => ({ type: "tableRow", content: cells });
  const table = (...rows: unknown[]) => doc({ type: "table", content: rows });

  it("pads a colspan so the body stays under its header", () => {
    const t = table(
      row(
        cell("tableHeader", "wide", { colspan: 2 }),
        cell("tableHeader", "last"),
      ),
      row(
        cell("tableCell", "a"),
        cell("tableCell", "b"),
        cell("tableCell", "c"),
      ),
    );
    expect(adfToMarkdown(t)).toBe("|wide||last|\n|:-:|:-:|:-:|\n|a|b|c|");
  });

  it("leaves an empty cell under a rowspan in the following rows", () => {
    const t = table(
      row(
        cell("tableHeader", "h1"),
        cell("tableHeader", "h2"),
        cell("tableHeader", "h3"),
      ),
      row(
        cell("tableCell", "tall", { rowspan: 2 }),
        cell("tableCell", "a"),
        cell("tableCell", "b"),
      ),
      row(cell("tableCell", "c"), cell("tableCell", "d")),
      row(
        cell("tableCell", "e"),
        cell("tableCell", "f"),
        cell("tableCell", "g"),
      ),
    );
    expect(adfToMarkdown(t)).toBe(
      "|h1|h2|h3|\n|:-:|:-:|:-:|\n|tall|a|b|\n||c|d|\n|e|f|g|",
    );
  });

  it("handles a colspan and a rowspan on one cell", () => {
    const t = table(
      row(
        cell("tableCell", "big", { colspan: 2, rowspan: 2 }),
        cell("tableCell", "x"),
      ),
      row(cell("tableCell", "y")),
    );
    expect(adfToMarkdown(t)).toBe("|big||x|\n|||y|");
  });

  it("caps absurd spans", () => {
    const t = table(row(cell("tableCell", "a", { colspan: 1e9 })));
    expect(adfToMarkdown(t).split("|").length).toBeLessThan(200);
  });
});
