import { createHash } from "node:crypto";

/**
 * The parts of a chat history item the journal reads. Structural, so the
 * package needs no core types: both hosts' items (core's ChatHistoryItem)
 * match it.
 */
export interface JournalSourceItem {
  message: {
    role: string;
    content?: unknown;
    toolCalls?: {
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
    toolCallId?: string;
  };
  contextItems?: { name?: string; content?: string }[];
  toolCallStates?: {
    toolCallId?: string;
    status?: string;
    toolCall?: { function?: { name?: string; arguments?: string } };
    output?: { name?: string; content?: string }[];
  }[];
  reasoning?: { text?: string };
  conversationSummary?: string;
}

/** A tool call in a stored item: what was asked and what came back */
export interface StoredToolCall {
  id?: string;
  name?: string;
  args?: string;
  status?: string;
  output?: string;
}

/**
 * An item as the journal stores it: what the model saw and what a person
 * would want to read back. UI state (ids, editor state, prompt logs,
 * checkpoints, timing) is left out.
 */
export interface StoredItem {
  role: string;
  /** Text parts joined; each image is "[image]" */
  content: string;
  /** A digest of each image's URL, in order: the images aren't kept */
  images?: string[];
  reasoning?: string;
  context?: { name?: string; content: string }[];
  toolCalls?: StoredToolCall[];
  toolCallId?: string;
  summary?: string;
}

export type JournalLine =
  | { t: "head"; v: 1; nonce: string; workspace?: string }
  | { t: "put"; i: number; h: string; ts: number; item: StoredItem }
  | { t: "cut"; n: number; ts: number }
  | { t: "fold"; from: number; n: number; ts: number }
  | { t: "summary"; i: number; text: string | null; ts: number };

const UNFINISHED = new Set(["generating", "generated", "calling"]);

const digest = (text: string) =>
  createHash("sha256").update(text).digest("base64url").slice(0, 22);

/**
 * A digest of each image's URL. The images themselves aren't kept (a data
 * URL can be megabytes); the digest makes replacing one a change.
 */
function imageDigests(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((part) => part?.type === "imageUrl")
    .map((part) => digest(String(part.imageUrl?.url ?? "")));
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) =>
      part?.type === "text" && typeof part.text === "string"
        ? part.text
        : part?.type === "imageUrl"
          ? "[image]"
          : "",
    )
    .join("");
}

/**
 * The stored form of an item, without its summary: the summary changes in
 * place (VS Code sets and removes it on an existing message), so it is kept
 * out of the hash and journaled on its own line.
 */
function project(item: JournalSourceItem): StoredItem {
  const { message } = item;
  const stored: StoredItem = {
    role: message.role,
    content: contentText(message.content),
  };
  const images = imageDigests(message.content);
  if (images.length) {
    stored.images = images;
  }
  if (item.reasoning?.text) {
    stored.reasoning = item.reasoning.text;
  }
  const context = (item.contextItems ?? [])
    .filter((c) => typeof c.content === "string" && c.content)
    .map((c) => ({ name: c.name, content: c.content as string }));
  if (context.length) {
    stored.context = context;
  }
  // Tool calls with their results where the host keeps them (both hosts put
  // them on the assistant item), else the calls the message asked for
  const states = item.toolCallStates ?? [];
  const calls: StoredToolCall[] = states.length
    ? states.map((s) => ({
        id: s.toolCallId,
        name: s.toolCall?.function?.name,
        args: s.toolCall?.function?.arguments,
        status: s.status,
        output: (s.output ?? [])
          .map((o) => o.content ?? "")
          .filter(Boolean)
          .join("\n"),
      }))
    : (message.toolCalls ?? []).map((c) => ({
        id: c.id,
        name: c.function?.name,
        args: c.function?.arguments,
      }));
  if (calls.length) {
    stored.toolCalls = calls;
  }
  if (message.toolCallId) {
    stored.toolCallId = message.toolCallId;
  }
  return stored;
}

interface CachedHash {
  toolCallStates: unknown;
  contextItems: unknown;
  reasoning: unknown;
  h: string;
}

// Keyed by the message object: cn keeps an item's message (and its tool
// states while they don't change) across saves, so an unchanged item isn't
// serialized again. Core gets fresh objects over IPC and always misses.
const hashCache = new WeakMap<object, CachedHash>();

export function itemHash(item: JournalSourceItem): string {
  const cached = hashCache.get(item.message);
  if (
    cached &&
    cached.toolCallStates === item.toolCallStates &&
    cached.contextItems === item.contextItems &&
    cached.reasoning === item.reasoning
  ) {
    return cached.h;
  }
  const h = digest(JSON.stringify(project(item)));
  hashCache.set(item.message, {
    toolCallStates: item.toolCallStates,
    contextItems: item.contextItems,
    reasoning: item.reasoning,
    h,
  });
  return h;
}

export function storedItem(item: JournalSourceItem): StoredItem {
  const stored = project(item);
  if (item.conversationSummary) {
    stored.summary = item.conversationSummary;
  }
  return stored;
}

/**
 * How many items of a history are settled. Everything before the last user
 * message is; from it on, items up to the first with a tool call still
 * `generating`, `generated` (awaiting approval) or `calling`. Decided per
 * turn, not per item: VS Code saves a finished call's tool item while its
 * sibling calls still run.
 */
export function settledLength(history: JournalSourceItem[]): number {
  let start = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].message.role === "user") {
      start = i;
      break;
    }
  }
  for (let i = start; i < history.length; i++) {
    if (history[i].toolCallStates?.some((s) => UNFINISHED.has(s.status!))) {
      return i;
    }
  }
  return history.length;
}

/** The live view a journal's lines describe, replayed in order */
export class JournalReplay {
  nonce: string | undefined;
  /** Hash of each live item, in history order */
  live: string[] = [];
  /** The summary on each live item, if any */
  summaries: (string | undefined)[] = [];

  apply(line: JournalLine): void {
    switch (line.t) {
      case "head":
        this.nonce = line.nonce;
        break;
      case "put":
        this.cutTo(line.i);
        this.live.push(line.h);
        this.summaries.push(line.item.summary);
        break;
      case "cut":
        this.cutTo(line.n);
        break;
      case "fold":
        this.live.splice(line.from, line.n - line.from);
        this.summaries.splice(line.from, line.n - line.from);
        break;
      case "summary":
        if (line.i < this.live.length) {
          this.summaries[line.i] = line.text ?? undefined;
        }
        break;
    }
  }

  private cutTo(n: number): void {
    this.live.length = Math.min(this.live.length, n);
    this.summaries.length = this.live.length;
  }
}

/**
 * The lines that take a journal's live view to the history's settled items.
 * Applying them to `replay` leaves it describing the history.
 */
export function diffLines(
  replay: JournalReplay,
  history: JournalSourceItem[],
  now: number,
): JournalLine[] {
  const settled = history.slice(0, settledLength(history));
  const hashes = settled.map(itemHash);
  const { live } = replay;
  let k = 0;
  while (k < live.length && k < hashes.length && live[k] === hashes[k]) {
    k++;
  }
  const lines: JournalLine[] = [];
  for (let i = 0; i < k; i++) {
    const summary = settled[i].conversationSummary || undefined;
    if (summary !== replay.summaries[i]) {
      lines.push({ t: "summary", i, text: summary ?? null, ts: now });
    }
  }
  if (k < live.length) {
    // A summary the live view doesn't hold, where the live view goes on:
    // cn's compaction, which replaces the turns it covers with an item
    // carrying a new summary. They stay history, outside the context. A
    // summary already live from k on is a plain cut: VS Code after a delete
    // before it, or an edit of a message that carries it.
    const summary = settled[k]?.conversationSummary;
    if (summary && !replay.summaries.includes(summary, k)) {
      lines.push({ t: "fold", from: k, n: live.length, ts: now });
    } else if (k === settled.length) {
      lines.push({ t: "cut", n: k, ts: now });
    }
    // Otherwise the put at k cuts the rest
  }
  for (let i = k; i < settled.length; i++) {
    lines.push({
      t: "put",
      i,
      h: hashes[i],
      ts: now,
      item: storedItem(settled[i]),
    });
  }
  return lines;
}

export interface ParsedJournalLine {
  line: JournalLine;
  /** Byte offset of the line in its file, and its length without the \n */
  offset: number;
  length: number;
}

/**
 * The complete lines of a chunk of a journal that starts at byte `start`,
 * and the byte after the last of them. A line torn by a crash is skipped:
 * the writer after it started on a new line. Offsets are counted in the
 * bytes themselves: a torn line can end inside a multibyte character, which
 * decodes to a replacement character of another length.
 */
export function parseJournalLines(
  bytes: Buffer,
  start = 0,
): { lines: ParsedJournalLine[]; end: number } {
  const lines: ParsedJournalLine[] = [];
  let at = 0;
  for (
    let newline = bytes.indexOf(0x0a);
    newline !== -1;
    newline = bytes.indexOf(0x0a, at)
  ) {
    const length = newline - at;
    if (length) {
      try {
        lines.push({
          line: JSON.parse(
            bytes.subarray(at, newline).toString("utf8"),
          ) as JournalLine,
          offset: start + at,
          length,
        });
      } catch {
        // Torn: skipped
      }
    }
    at = newline + 1;
  }
  return { lines, end: start + at };
}
