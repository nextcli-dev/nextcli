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
  content: string;
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

/** Exposed for tests that check unchanged items aren't hashed again */
export const hashing = { count: 0 };

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
  hashing.count++;
  const h = createHash("sha256")
    .update(JSON.stringify(project(item)))
    .digest("base64url")
    .slice(0, 22);
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
 * generating, waiting or running. Decided per turn, not per item: VS Code
 * saves a finished call's tool item while its sibling calls still run.
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
    // A summary item the journal hasn't seen, where the live view goes on:
    // cn's compaction, which replaces the turns it covers. They stay
    // history, outside the context. A summary item already live (VS Code,
    // after a delete before it) is a plain cut.
    if (
      k < settled.length &&
      settled[k].conversationSummary &&
      !live.includes(hashes[k])
    ) {
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
