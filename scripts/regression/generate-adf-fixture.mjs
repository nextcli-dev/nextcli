#!/usr/bin/env node
// Records how adf-to-md 1.2.1 turns Jira's Atlassian Document Format (ADF)
// into Markdown, so the in-house converter that replaces it (Phase 3 of the
// dependency upgrade) can be checked against the same inputs.
//
// Note: JiraClient.ts calls `adf2md.validate(x).result`, but validate() only
// checks the document and returns nothing, so that line throws for every ADF
// description or comment (the default API version 3 returns ADF). The
// conversion lives in convert(); that is what is recorded here.
//
//   node scripts/regression/generate-adf-fixture.mjs
//
// Writes core/test/fixtures/regression/adf/golden.json:
//   [{ name, input, output, warnings } | { name, input, error }]

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const requireFromCore = createRequire(path.join(ROOT, "core/package.json"));
const adf2md = requireFromCore("adf-to-md");
const OUT = path.join(ROOT, "core/test/fixtures/regression/adf");

const t = (text, marks) =>
  marks ? { type: "text", text, marks } : { type: "text", text };
const p = (...content) => ({ type: "paragraph", content });
const doc = (...content) => ({ type: "doc", version: 1, content });
const li = (...content) => ({ type: "listItem", content });
const cell = (type, ...content) => ({ type, attrs: {}, content });
const mark = (type, attrs) => (attrs ? { type, attrs } : { type });

const CASES = {
  "empty doc": doc(),
  "empty paragraph": doc(p()),
  "plain paragraphs": doc(p(t("First paragraph.")), p(t("Second paragraph."))),
  "strong, em, code, strike": doc(
    p(
      t("bold", [mark("strong")]),
      t(" "),
      t("italic", [mark("em")]),
      t(" "),
      t("inline()", [mark("code")]),
      t(" "),
      t("gone", [mark("strike")]),
    ),
  ),
  link: doc(
    p(
      t("See "),
      t("the docs", [
        mark("link", { href: "https://docs.example.dev/a?b=1&c=2" }),
      ]),
      t("."),
    ),
  ),
  "stacked marks (order matters)": doc(
    p(
      t("bold link", [mark("strong"), mark("link", { href: "https://x.dev" })]),
    ),
    p(
      t("link bold", [mark("link", { href: "https://x.dev" }), mark("strong")]),
    ),
  ),
  "unsupported marks (underline, textColor, subsup)": doc(
    p(
      t("under", [mark("underline")]),
      t(" red", [mark("textColor", { color: "#ff0000" })]),
      t(" sub", [mark("subsup", { type: "sub" })]),
    ),
  ),
  "headings 1-6": doc(
    ...[1, 2, 3, 4, 5, 6].map((level) => ({
      type: "heading",
      attrs: { level },
      content: [t(`Heading ${level}`)],
    })),
  ),
  "heading with marks": doc({
    type: "heading",
    attrs: { level: 2 },
    content: [t("Fix "), t("parseConfig", [mark("code")])],
  }),
  "hard break": doc(p(t("line one"), { type: "hardBreak" }, t("line two"))),
  "bullet list": doc({
    type: "bulletList",
    content: [li(p(t("apples"))), li(p(t("pears"))), li(p(t("plums")))],
  }),
  "ordered list default start": doc({
    type: "orderedList",
    content: [li(p(t("one"))), li(p(t("two"))), li(p(t("three")))],
  }),
  "ordered list starting at 5": doc({
    type: "orderedList",
    attrs: { order: 5 },
    content: [li(p(t("five"))), li(p(t("six")))],
  }),
  "nested lists": doc({
    type: "bulletList",
    content: [
      li(p(t("parent")), {
        type: "orderedList",
        content: [li(p(t("child one"))), li(p(t("child two")))],
      }),
      li(p(t("sibling"))),
    ],
  }),
  "list item with two paragraphs": doc({
    type: "bulletList",
    content: [li(p(t("first para")), p(t("second para")))],
  }),
  "code block with language": doc({
    type: "codeBlock",
    attrs: { language: "typescript" },
    content: [t("const x: number = 1;\nconsole.log(x);")],
  }),
  "code block without language": doc({
    type: "codeBlock",
    content: [t("plain code")],
  }),
  "code block with empty attrs": doc({
    type: "codeBlock",
    attrs: {},
    content: [t("attrs but no language")],
  }),
  blockquote: doc({
    type: "blockquote",
    content: [p(t("quoted one")), p(t("quoted two"))],
  }),
  "rule between paragraphs": doc(
    p(t("above")),
    { type: "rule" },
    p(t("below")),
  ),
  emoji: doc(
    p(t("Ship it "), {
      type: "emoji",
      attrs: { shortName: ":rocket:", id: "1f680", text: "🚀" },
    }),
  ),
  "mention (unsupported)": doc(
    p(
      t("Ping "),
      { type: "mention", attrs: { id: "abc", text: "@Ann Lee" } },
      t(" please"),
    ),
  ),
  "inline card": doc(
    p(t("Ticket: "), {
      type: "inlineCard",
      attrs: { url: "https://acme.atlassian.net/browse/NX-1" },
    }),
  ),
  "block card": doc({
    type: "blockCard",
    attrs: { url: "https://github.com/acme/repo/pull/7" },
  }),
  "table with header row": doc({
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          cell("tableHeader", p(t("Name"))),
          cell("tableHeader", p(t("Status"))),
        ],
      },
      {
        type: "tableRow",
        content: [
          cell("tableCell", p(t("parser"))),
          cell("tableCell", p(t("done", [mark("strong")]))),
        ],
      },
      {
        type: "tableRow",
        content: [cell("tableCell", p(t("lexer"))), cell("tableCell", p())],
      },
    ],
  }),
  "table without header": doc({
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [cell("tableCell", p(t("a"))), cell("tableCell", p(t("b")))],
      },
    ],
  }),
  "panel (unsupported)": doc({
    type: "panel",
    attrs: { panelType: "info" },
    content: [p(t("Heads up: this is in a panel."))],
  }),
  "media (unsupported)": doc({
    type: "mediaSingle",
    attrs: { layout: "center" },
    content: [
      { type: "media", attrs: { id: "m1", type: "file", collection: "c" } },
    ],
  }),
  "status, date, expand (unsupported)": doc(
    p(
      { type: "status", attrs: { text: "IN PROGRESS", color: "blue" } },
      t(" since "),
      { type: "date", attrs: { timestamp: "1762300800000" } },
    ),
    {
      type: "expand",
      attrs: { title: "Details" },
      content: [p(t("hidden text"))],
    },
  ),
  "task list (unsupported)": doc({
    type: "taskList",
    attrs: { localId: "t" },
    content: [
      {
        type: "taskItem",
        attrs: { localId: "1", state: "DONE" },
        content: [t("write tests")],
      },
    ],
  }),
  "markdown special characters in text": doc(
    p(t("Use *stars*, _underscores_, `ticks`, # hashes and | pipes")),
  ),
  unicode: doc(p(t("Ünïcödé — 日本語 — emoji 🙂 — RTL עברית"))),
  "realistic bug report": doc(
    {
      type: "heading",
      attrs: { level: 3 },
      content: [t("Steps to reproduce")],
    },
    {
      type: "orderedList",
      content: [
        li(p(t("Open "), t("settings.json", [mark("code")]))),
        li(p(t("Set "), t("apiVersion", [mark("code")]), t(" to 3"))),
        li(p(t("Run "), t("@jira", [mark("strong")]))),
      ],
    },
    { type: "heading", attrs: { level: 3 }, content: [t("Actual")] },
    {
      type: "codeBlock",
      attrs: { language: "text" },
      content: [
        t("TypeError: Cannot read properties of undefined (reading 'result')"),
      ],
    },
    p(
      t("See "),
      t("NX-42", [
        mark("link", { href: "https://acme.atlassian.net/browse/NX-42" }),
      ]),
      t("."),
    ),
  ),
  // Inputs the library rejects; JiraClient only passes non-string, truthy values.
  "invalid: missing version": { type: "doc", content: [p(t("x"))] },
  "invalid: wrong root type": { type: "paragraph", content: [t("x")] },
};

function main() {
  mkdirSync(OUT, { recursive: true });
  const cases = [];
  // convert() prints "adding warning for <type>" for each unsupported node.
  const log = console.log;
  console.log = () => {};
  try {
    for (const [name, input] of Object.entries(CASES)) {
      // convert() mutates ordered lists, so keep the untouched input.
      const pristine = structuredClone(input);
      try {
        const { result, warnings } = adf2md.convert(input);
        cases.push({
          name,
          input: pristine,
          output: result,
          warnings: [...warnings].sort(),
        });
      } catch (err) {
        cases.push({ name, input: pristine, error: err.message });
      }
    }
  } finally {
    console.log = log;
  }
  const golden = {
    generatedWith: {
      "adf-to-md": requireFromCore("adf-to-md/package.json").version,
      function: "convert",
    },
    cases,
  };
  writeFileSync(
    path.join(OUT, "golden.json"),
    JSON.stringify(golden, null, 2) + "\n",
  );
  console.log(
    `Wrote ${path.relative(ROOT, OUT)}/golden.json: ${cases.length} cases, ` +
      `${cases.filter((c) => c.error).length} rejected inputs, ` +
      `${cases.filter((c) => c.warnings?.length).length} with unsupported nodes or marks.`,
  );
}

main();
