import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import {
  diffLines,
  itemHash,
  JournalLine,
  JournalReplay,
  JournalSourceItem,
  parseJournalLines,
  settledLength,
  storedItem,
} from "./journal.js";

interface JournalState {
  replay: JournalReplay;
  /** Bytes of the file this process has replayed */
  size: number;
}

const states = new Map<string, JournalState>();

function readFrom(path: string, offset: number, size: number): Buffer {
  const fd = fs.openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

/** The state for a journal file, caught up with what other writers added */
function caughtUp(path: string, size: number): JournalState {
  let state = states.get(path);
  if (state && size >= state.size) {
    if (size > state.size) {
      const { lines } = parseJournalLines(readFrom(path, state.size, size));
      const nonce = state.replay.nonce;
      if (lines.some(({ line }) => line.t === "head" && line.nonce !== nonce)) {
        state = undefined;
      } else {
        for (const { line } of lines) {
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
    const bytes = size ? readFrom(path, 0, size) : Buffer.alloc(0);
    for (const { line } of parseJournalLines(bytes).lines) {
      replay.apply(line);
    }
    state = { replay, size };
    states.set(path, state);
  }
  return state;
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

/** Enough for a head line: a nonce and a workspace path */
const HEAD_BYTES = 8192;

/**
 * A transcript's head line: its nonce and the workspace it was started in.
 * Undefined when the file can't be read or doesn't start with one.
 */
export function readJournalHead(
  path: string,
): Extract<JournalLine, { t: "head" }> | undefined {
  try {
    const fd = fs.openSync(path, "r");
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
      const first = parseJournalLines(buffer.subarray(0, n)).lines[0]?.line;
      return first?.t === "head" ? first : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
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
  const size = fs.statSync(path, { throwIfNoEntry: false })?.size ?? 0;
  const known = states.get(path);
  // The file is as this process left it: no other writer (cn and VS Code on
  // one session) added a turn, a cut or a fold this history would undo
  if (known && known.size === size) {
    // Most saves change nothing settled (cn saves on every tool status and
    // Bash chunk): compare hashes before reading the file
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
  try {
    append(path, size, history, now, options);
  } catch (e) {
    // The replay may now hold lines the file doesn't (a full disk, a lost
    // permission): read the file again next time, so the next save writes
    // them instead of finding nothing changed
    states.delete(path);
    throw e;
  }
}

function append(
  path: string,
  size: number,
  history: JournalSourceItem[],
  now: number,
  options: SyncJournalOptions,
): void {
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
  // After a line torn by a crash, start on a new line
  const prefix =
    size > 0 && readFrom(path, size - 1, size)[0] !== 0x0a ? "\n" : "";
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
