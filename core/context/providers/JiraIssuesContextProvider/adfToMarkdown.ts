/**
 * Converts Jira's Atlassian Document Format (ADF) to Markdown.
 *
 * Replaces the adf-to-md package. Output matches adf-to-md 1.2.1's convert()
 * (recorded in core/test/fixtures/regression/adf/golden.json) except where
 * that output lost content or was malformed; adfToMarkdown.vitest.ts lists
 * each intentional difference.
 *
 * Unknown nodes render their text and children, so new ADF node types degrade
 * to plain text instead of disappearing. Malformed input never throws: bad
 * fields are skipped, and if conversion still fails the document's plain text
 * is returned, so one bad node cannot fail a whole Jira issue.
 */

export interface AdfMark {
  type: string;
  attrs?: Record<string, any>;
}

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: AdfMark[];
  content?: AdfNode[];
}

const LIST_INDENT = "  ";
// Table spans come from user content; cap them so a bad value can't allocate
// an unbounded number of cells.
const MAX_SPAN = 100;

export function adfToMarkdown(doc: unknown): string {
  try {
    return convert(doc);
  } catch {
    try {
      return isNode(doc) ? plainText(doc).trim() : "";
    } catch {
      return "";
    }
  }
}

function convert(doc: unknown): string {
  if (!isNode(doc)) {
    return "";
  }
  const blocks = doc.type === "doc" ? children(doc) : [doc];
  return renderBlocks(blocks).trimEnd();
}

function isNode(value: unknown): value is AdfNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AdfNode).type === "string"
  );
}

/** A string attribute or text value; anything else counts as missing. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function renderBlocks(nodes: AdfNode[]): string {
  return nodes
    .map(renderBlock)
    .filter((block) => block !== "")
    .join("\n\n");
}

// A node's children: inline children (text, mentions, ...) join into one line
// of text, block children into separate blocks.
function renderChildren(node: AdfNode): string {
  const kids = children(node);
  return kids.length > 0 && kids.every(isInlineNode)
    ? renderInline(kids)
    : renderBlocks(kids);
}

function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(children(node));
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      return `${"#".repeat(level)} ${renderInline(children(node))}`;
    }
    case "bulletList":
    case "orderedList":
    case "taskList":
      return renderList(node, LIST_INDENT);
    case "codeBlock":
      return renderCodeBlock(node);
    case "blockquote":
    case "panel":
      return quote(renderBlocksTight(children(node)));
    case "rule":
      return "---";
    case "table":
      return renderTable(node);
    case "blockCard":
    case "embedCard":
      return renderCard(node);
    case "expand":
    case "nestedExpand": {
      const title = str(node.attrs?.title);
      return [title ? `**${title}**` : "", renderBlocks(children(node))]
        .filter((part) => part !== "")
        .join("\n\n");
    }
    case "mediaSingle":
    case "mediaGroup":
      return children(node)
        .map(renderBlock)
        .filter((block) => block !== "")
        .join("\n");
    case "media":
      return renderMedia(node);
    default:
      return isInlineNode(node) ? renderInline([node]) : renderChildren(node);
  }
}

// Blockquote paragraphs on consecutive lines, as adf-to-md rendered them.
function renderBlocksTight(nodes: AdfNode[]): string {
  return nodes
    .map(renderBlock)
    .filter((block) => block !== "")
    .join("\n");
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

// The fence is longer than any run of backticks in the code, so the code can't
// close it early. The language is a single line.
function renderCodeBlock(node: AdfNode): string {
  const body = plainText(node);
  const language = str(node.attrs?.language)
    .replace(/[\r\n`]+/g, "")
    .trim();
  const longestRun = (body.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language ? ` ${language}` : ""}\n${body}\n${fence}`;
}

function renderList(list: AdfNode, indent: string): string {
  const start = Number(list.attrs?.order) || 1;
  return children(list)
    .map((item, index) => {
      const marker = list.type === "orderedList" ? `${start + index}.` : "*";
      const checkbox =
        list.type === "taskList"
          ? item.attrs?.state === "DONE"
            ? "[x] "
            : "[ ] "
          : "";
      return renderListItem(item, indent, marker, checkbox);
    })
    .join("\n");
}

// Content of an item (further paragraphs, nested lists, code) is indented to
// the item's content column, just past the marker, which keeps it inside the
// item and keeps a code fence a fence. Blank lines stay empty.
function renderListItem(
  item: AdfNode,
  indent: string,
  marker: string,
  checkbox: string,
): string {
  const contentIndent = indent + " ".repeat(marker.length + 1);
  const markerLine = (text: string) =>
    `${indent}${marker} ${checkbox}${text}`.trimEnd();

  const content = children(item);
  // taskItem holds inline content directly; listItem holds blocks
  const blocks =
    content.length > 0 && content.every(isInlineNode)
      ? [{ type: "paragraph", content }]
      : content;

  const lines: string[] = [];
  for (const block of blocks) {
    if (isList(block)) {
      // A nested list can come first: the item still needs its own marker.
      if (lines.length === 0) {
        lines.push(markerLine(""));
      }
      lines.push(renderList(block, contentIndent));
      continue;
    }
    for (const line of renderBlock(block).split("\n")) {
      if (lines.length === 0) {
        lines.push(markerLine(line));
      } else {
        lines.push(line === "" ? "" : contentIndent + line);
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : markerLine("");
}

function isList(node: AdfNode): boolean {
  return (
    node.type === "bulletList" ||
    node.type === "orderedList" ||
    node.type === "taskList"
  );
}

function span(value: unknown): number {
  return Math.min(Math.max(Math.floor(Number(value)) || 1, 1), MAX_SPAN);
}

// Merged cells: a cell with colspan N is followed by N-1 empty cells, and a
// cell with rowspan N leaves an empty cell in the next N-1 rows, so every
// cell stays under its own column header.
function renderTable(table: AdfNode): string {
  const lines: string[] = [];
  const coveredRows: number[] = [];
  const rows = children(table).filter((row) => row.type === "tableRow");

  rows.forEach((row, index) => {
    const cells: string[] = [];
    let isHeader = false;
    const skipCovered = () => {
      while ((coveredRows[cells.length] ?? 0) > 0) {
        coveredRows[cells.length]--;
        cells.push("");
      }
    };

    for (const cell of children(row)) {
      skipCovered();
      const text = renderCell(cell);
      const rowspan = span(cell.attrs?.rowspan);
      isHeader ||= cell.type === "tableHeader";
      for (let i = 0; i < span(cell.attrs?.colspan); i++) {
        coveredRows[cells.length] = rowspan - 1;
        cells.push(i === 0 ? text : "");
      }
    }
    skipCovered();

    lines.push(`|${cells.join("|")}|`);
    if (index === 0 && isHeader) {
      lines.push(`|${cells.map(() => ":-:").join("|")}|`);
    }
  });
  return lines.join("\n");
}

function renderCell(cell: AdfNode): string {
  return renderBlocks(children(cell))
    .replace(/\n+/g, " ")
    .replace(/\|/g, "\\|");
}

function renderCard(node: AdfNode): string {
  const url = str(node.attrs?.url);
  return url ? `[${url}](${url})` : "";
}

// Files and images can't go into text, but the ticket shouldn't look empty or
// lose what was attached.
function renderMedia(node: AdfNode): string {
  const alt = str(node.attrs?.alt).trim();
  return alt ? `[attachment: ${alt}]` : "[attachment]";
}

const INLINE_TYPES = new Set([
  "text",
  "hardBreak",
  "emoji",
  "mention",
  "inlineCard",
  "mediaInline",
  "status",
  "date",
  "placeholder",
]);

function isInlineNode(node: AdfNode): boolean {
  return INLINE_TYPES.has(node.type);
}

function renderInline(nodes: AdfNode[]): string {
  return nodes.map(renderInlineNode).join("");
}

function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return applyMarks(str(node.text), node.marks);
    case "hardBreak":
      return "\n";
    case "emoji":
      return str(node.attrs?.shortName) || str(node.attrs?.text);
    case "mention":
      return str(node.attrs?.text) || "@unknown";
    case "inlineCard":
      return renderCard(node);
    case "mediaInline":
      return renderMedia(node);
    case "status": {
      const text = str(node.attrs?.text);
      return text ? `[${text}]` : "";
    }
    case "date":
      return formatDate(node.attrs?.timestamp);
    default:
      return str(node.text) || renderInline(children(node));
  }
}

function formatDate(timestamp: unknown): string {
  const date = new Date(Number(timestamp));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

// Each mark wraps the result of the previous one, so the first mark is
// innermost: [strong, link] gives [**text**](url). Anything that isn't a mark
// object is skipped, and the text is kept.
function applyMarks(text: string, marks: unknown): string {
  if (!Array.isArray(marks)) {
    return text;
  }
  let result = text;
  for (const mark of marks) {
    if (typeof mark !== "object" || mark === null) {
      continue;
    }
    switch (mark.type) {
      case "strong":
        result = `**${result}**`;
        break;
      case "em":
        result = `_${result}_`;
        break;
      case "code":
        result = `\`${result}\``;
        break;
      case "strike":
        result = `~~${result}~~`;
        break;
      case "link": {
        const href = str(mark.attrs?.href);
        if (href) {
          result = `[${result}](${href})`;
        }
        break;
      }
      default:
        // underline, textColor, subsup, ...: no Markdown equivalent
        break;
    }
  }
  return result;
}

function plainText(node: AdfNode): string {
  return typeof node.text === "string"
    ? node.text
    : children(node).map(plainText).join("");
}
