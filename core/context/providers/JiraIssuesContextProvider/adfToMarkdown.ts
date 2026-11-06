/**
 * Converts Jira's Atlassian Document Format (ADF) to Markdown.
 *
 * Replaces the adf-to-md package. Output matches adf-to-md 1.2.1's convert()
 * (recorded in core/test/fixtures/regression/adf/golden.json) except where
 * that output lost content or was malformed; adfToMarkdown.vitest.ts lists
 * each intentional difference.
 *
 * Unknown nodes render their text and children, so new ADF node types degrade
 * to plain text instead of disappearing. Malformed input never throws.
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

export function adfToMarkdown(doc: unknown): string {
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

function children(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : [];
}

function renderBlocks(nodes: AdfNode[]): string {
  return nodes
    .map(renderBlock)
    .filter((block) => block !== "")
    .join("\n\n");
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
      return renderList(node, "");
    case "codeBlock": {
      const language = node.attrs?.language;
      const fence = language ? `\`\`\` ${language}` : "```";
      return `${fence}\n${plainText(node)}\n\`\`\``;
    }
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
      const title = node.attrs?.title ? `**${node.attrs.title}**` : "";
      return [title, renderBlocks(children(node))]
        .filter((part) => part !== "")
        .join("\n\n");
    }
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "";
    default:
      return isInlineNode(node)
        ? renderInline([node])
        : renderBlocks(children(node));
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

function renderList(list: AdfNode, indent: string): string {
  const start = Number(list.attrs?.order) || 1;
  return children(list)
    .map((item, index) => {
      const marker =
        list.type === "orderedList"
          ? `${start + index}.`
          : list.type === "taskList"
            ? item.attrs?.state === "DONE"
              ? "* [x]"
              : "* [ ]"
            : "*";
      return renderListItem(item, `${indent}${LIST_INDENT}`, marker);
    })
    .join("\n");
}

function renderListItem(item: AdfNode, indent: string, marker: string): string {
  const lines: string[] = [];
  const content = children(item);
  // taskItem holds inline content directly; listItem holds blocks
  const blocks = content.every(isInlineNode)
    ? [{ type: "paragraph", content }]
    : content;
  for (const block of blocks) {
    if (isList(block)) {
      lines.push(renderList(block, indent));
      continue;
    }
    const text = renderBlock(block);
    if (text === "") {
      continue;
    }
    const prefix = lines.length === 0 ? `${indent}${marker} ` : `${indent}  `;
    lines.push(
      text
        .split("\n")
        .map((line, i) => (i === 0 ? prefix + line : `${indent}  ${line}`))
        .join("\n"),
    );
  }
  return lines.length > 0 ? lines.join("\n") : `${indent}${marker} `;
}

function isList(node: AdfNode): boolean {
  return (
    node.type === "bulletList" ||
    node.type === "orderedList" ||
    node.type === "taskList"
  );
}

function renderTable(table: AdfNode): string {
  const rows = children(table).filter((row) => row.type === "tableRow");
  const lines: string[] = [];
  rows.forEach((row, index) => {
    const cells = children(row);
    lines.push(`|${cells.map(renderCell).join("|")}|`);
    if (index === 0 && cells.some((cell) => cell.type === "tableHeader")) {
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
  const url = node.attrs?.url;
  return typeof url === "string" && url ? `[${url}](${url})` : "";
}

const INLINE_TYPES = new Set([
  "text",
  "hardBreak",
  "emoji",
  "mention",
  "inlineCard",
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
      return applyMarks(node.text ?? "", node.marks);
    case "hardBreak":
      return "\n";
    case "emoji":
      return node.attrs?.shortName ?? node.attrs?.text ?? "";
    case "mention": {
      const text = node.attrs?.text;
      return typeof text === "string" && text ? text : "@unknown";
    }
    case "inlineCard":
      return renderCard(node);
    case "status":
      return node.attrs?.text ? `[${node.attrs.text}]` : "";
    case "date":
      return formatDate(node.attrs?.timestamp);
    default:
      return node.text ?? renderInline(children(node));
  }
}

function formatDate(timestamp: unknown): string {
  const ms = Number(timestamp);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
}

// Each mark wraps the result of the previous one, so the first mark is
// innermost: [strong, link] gives [**text**](url).
function applyMarks(text: string, marks: AdfMark[] | undefined): string {
  let result = text;
  for (const mark of marks ?? []) {
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
      case "link":
        if (mark.attrs?.href) {
          result = `[${result}](${mark.attrs.href})`;
        }
        break;
      default:
        // underline, textColor, subsup, ...: no Markdown equivalent
        break;
    }
  }
  return result;
}

function plainText(node: AdfNode): string {
  return node.text ?? children(node).map(plainText).join("");
}
