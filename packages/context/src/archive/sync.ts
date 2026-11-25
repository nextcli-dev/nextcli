import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import {
  diffLines,
  itemHash,
  JournalLine,
  JournalReplay,
  JournalSourceItem,
  settledLength,
  storedItem,
} from "./journal.js";

interface JournalState {
  replay: JournalReplay;
  /** Bytes of the file this process has replayed */
  size: number;
}

const states = new Map<string, JournalState>();

/** Complete lines of a journal chunk, with what's left of a partial one */
function parseLines(text: string): JournalLine[] {
  const end = text.lastIndexOf("\n");
  const lines: JournalLine[] = [];
  for (const raw of text.slice(0, end + 1).split("\n")) {
    if (!raw) {
      continue;
    }
    try {
      lines.push(JSON.parse(raw) as JournalLine);
    } catch {
      // A line torn by a crash mid-append: the writer after it starts on a
      // new line, so only this one is lost
    }
  }
  return lines;
}

function readFrom(path: string, offset: number, size: number): string {
  const fd = fs.openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** The state for a journal file, caught up with what other writers added */
function caughtUp(path: string, size: number): JournalState {
  let state = states.get(path);
  if (state && size >= state.size) {
    if (size > state.size) {
      const lines = parseLines(readFrom(path, state.size, size));
      const nonce = state.replay.nonce;
      if (lines.some((l) => l.t === "head" && l.nonce !== nonce)) {
        state = undefined;
      } else {
        for (const line of lines) {
          state.replay.apply(line);
        }
        state.size = size;
      }
    }
  } else {
    state = undefined;
  }
  if (!state) {
    // Not read yet in this process, or recreated (shorter, or a new head)
    const replay = new JournalReplay();
    for (const line of parseLines(size ? readFrom(path, 0, size) : "")) {
      replay.apply(line);
    }
    state = { replay, size };
    states.set(path, state);
  }
  return state;
}

function endsWithNewline(path: string, size: number): boolean {
  return size === 0 || readFrom(path, size - 1, size) === "\n";
}

function backfill(path: string): JournalSourceItem[] {
  try {
    const history = JSON.parse(fs.readFileSync(path, "utf8")).history;
    // A file can hold anything: keep only items with a message
    return Array.isArray(history)
      ? history.filter((item) => typeof item?.message?.role === "string")
      : [];
  } catch {
    return [];
  }
}

export interface SyncJournalOptions {
  /**
   * The session file the journal belongs to. A session saved before the
   * journal existed has turns only there: when the journal is missing, they
   * are journaled first, so a first save that compacts doesn't lose them.
   */
  sessionFile?: string;
  workspace?: string;
}

/**
 * Appends to `path` whatever takes the journal to `history`: the settled
 * items the journal doesn't have, a cut when the history got shorter, a
 * fold when a compaction replaced turns with a summary. Nothing is ever
 * removed from the file. Call it before the session file is written.
 */
export function syncJournal(
  path: string,
  history: JournalSourceItem[],
  options: SyncJournalOptions = {},
): void {
  const now = Date.now();
  const known = states.get(path);
  if (known) {
    // Most saves change nothing settled (cn saves on every tool status and
    // Bash chunk): compare hashes before touching the file
    const settled = history.slice(0, settledLength(history));
    const { live, summaries } = known.replay;
    if (
      settled.length === live.length &&
      settled.every(
        (item, i) =>
          itemHash(item) === live[i] &&
          (item.conversationSummary || undefined) === summaries[i],
      )
    ) {
      return;
    }
  }

  const size = fs.existsSync(path) ? fs.statSync(path).size : 0;
  const state = caughtUp(path, size);
  const lines: JournalLine[] = [];
  if (size === 0) {
    lines.push({
      t: "head",
      v: 1,
      nonce: randomUUID(),
      workspace: options.workspace,
    });
    const earlier = options.sessionFile ? backfill(options.sessionFile) : [];
    for (let i = 0; i < earlier.length; i++) {
      lines.push({
        t: "put",
        i,
        h: itemHash(earlier[i]),
        ts: now,
        item: storedItem(earlier[i]),
      });
    }
    for (const line of lines) {
      state.replay.apply(line);
    }
  }
  const changes = diffLines(state.replay, history, now);
  for (const line of changes) {
    state.replay.apply(line);
  }
  lines.push(...changes);
  if (!lines.length) {
    return;
  }
  const prefix = endsWithNewline(path, size) ? "" : "\n";
  const text = prefix + lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.appendFileSync(path, text);
  state.size = size + Buffer.byteLength(text);
}

/** Drops what this process remembers of a journal (deleted, or cleared) */
export function forgetJournal(path?: string): void {
  if (path === undefined) {
    states.clear();
  } else {
    states.delete(path);
  }
}
