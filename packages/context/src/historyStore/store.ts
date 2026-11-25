import * as fs from "node:fs";
import * as path from "node:path";

import {
  parseJournalLines,
  type JournalLine,
  type ParsedJournalLine,
  type StoredItem,
} from "../archive/journal.js";
import {
  SqliteDatabase,
  sqliteHasFts5,
  type SqliteTransaction,
} from "../sqlite.js";

/** Where an item stands in its session: in it, undone, or compacted away */
export type HistoryState = "live" | "cut" | "folded";

export interface HistoryHit {
  sessionId: string;
  /** The item's position in its transcript: pass it to read() */
  ord: number;
  role: string;
  tool?: string;
  state: HistoryState;
  ts: number;
  snippet: string;
}

export interface HistorySearchResult {
  hits: HistoryHit[];
  /** Searched without FTS5 (Node 22.15): substring matches, newest first */
  basic: boolean;
  /** Transcripts not indexed yet: the search ran out of time, or was busy */
  pending: number;
}

export interface HistoryReadItem {
  ord: number;
  state: HistoryState;
  ts: number;
  text: string;
}

export interface HistoryStoreOptions {
  /** The index database; keep it outside the sessions folder */
  dbPath: string;
  /** The folder holding the `<id>.jsonl` transcripts */
  sessionsDir: string;
  /** Applied to every text before it is indexed or read back */
  redact: (text: string) => string;
  /** Word search with FTS5; off by default where node:sqlite lacks it */
  fts?: boolean;
}

const CHUNK_CHARS = 8_000;
// A chunk's rowid is its item's id * MAX_CHUNKS + its index, so an item's
// chunks are one rowid range
const MAX_CHUNKS = 1_000;
const BATCH_BYTES = 1_000_000;
const SYNC_BUDGET_MS = 300;
const READ_MAX_ITEMS = 40;
const READ_MAX_CHARS = 80_000;

class SyncRace extends Error {}

/** An item as plain text: what was said, done and returned */
export function itemText(item: StoredItem): string {
  const parts = [item.content, item.reasoning ?? ""];
  for (const call of item.toolCalls ?? []) {
    parts.push(`${call.name ?? "tool"}(${call.args ?? ""})`, call.output ?? "");
  }
  for (const context of item.context ?? []) {
    parts.push(context.content);
  }
  return parts.filter(Boolean).join("\n");
}

function readBytes(file: string, start: number, end: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

interface JournalRow {
  nonce: string | null;
  inode: string;
  offset: number;
  live: string;
}

/**
 * A full-text index over the session transcripts, brought up to date when it
 * is searched. cn and VS Code windows may share it: each claims the bytes it
 * indexes with a compare-and-set on the stored offset.
 */
export class HistoryStore {
  private readonly text: string;

  private constructor(
    private readonly db: SqliteDatabase,
    private readonly options: HistoryStoreOptions,
    private readonly fts: boolean,
  ) {
    this.text = fts ? "history_fts" : "history_text";
  }

  static async open(options: HistoryStoreOptions): Promise<HistoryStore> {
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    const db = await SqliteDatabase.open(options.dbPath);
    const fts = options.fts ?? sqliteHasFts5();
    // node:sqlite waits on the calling thread, so the wait stays short
    await db.exec("PRAGMA busy_timeout = 200");
    await db.exec("PRAGMA journal_mode = WAL");
    await db.exec("PRAGMA secure_delete = ON");
    await db.exec(`
      CREATE TABLE IF NOT EXISTS journals (
        session_id TEXT PRIMARY KEY,
        nonce TEXT,
        inode TEXT NOT NULL,
        offset INTEGER NOT NULL,
        live TEXT NOT NULL,
        workspace TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        role TEXT NOT NULL,
        tool TEXT,
        state TEXT NOT NULL,
        h TEXT NOT NULL,
        ts INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL,
        byte_len INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages (session_id, ord);
      ${
        fts
          ? "CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(text, tokenize = 'trigram');"
          : "CREATE TABLE IF NOT EXISTS history_text (rowid INTEGER PRIMARY KEY, text TEXT NOT NULL);"
      }
    `);
    return new HistoryStore(db, options, fts);
  }

  close(): Promise<void> {
    return this.db.close();
  }

  /**
   * Indexes what the transcripts gained since the last sync, within a time
   * budget, and forgets deleted ones. Returns how many it didn't get to.
   */
  async sync(sessionIds?: string[]): Promise<number> {
    const { sessionsDir } = this.options;
    const present = new Set(
      (fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [])
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => f.slice(0, -".jsonl".length)),
    );
    const indexed = await this.db.all<{ session_id: string }[]>(
      "SELECT session_id FROM journals",
    );
    for (const { session_id } of indexed) {
      if (!present.has(session_id)) {
        await this.drop(session_id);
      }
    }
    const startedAt = Date.now();
    let pending = 0;
    for (const sessionId of sessionIds ?? present) {
      if (!present.has(sessionId)) {
        continue;
      }
      try {
        if (!(await this.syncJournal(sessionId, startedAt))) {
          pending++;
        }
      } catch (e) {
        if ((e as { code?: string }).code !== "SQLITE_BUSY") {
          throw e;
        }
        pending++;
      }
    }
    return pending;
  }

  private async drop(sessionId: string): Promise<void> {
    const ids = await this.db.all<{ id: number }[]>(
      "SELECT id FROM messages WHERE session_id = ?",
      sessionId,
    );
    await this.db.transaction(
      (tx) => {
        for (const { id } of ids) {
          tx.run(
            `DELETE FROM ${this.text} WHERE rowid >= ? AND rowid < ?`,
            id * MAX_CHUNKS,
            (id + 1) * MAX_CHUNKS,
          );
        }
        tx.run("DELETE FROM messages WHERE session_id = ?", sessionId);
        tx.run("DELETE FROM journals WHERE session_id = ?", sessionId);
      },
      { immediate: true },
    );
  }

  /** Whether the transcript is indexed to its end */
  private async syncJournal(
    sessionId: string,
    startedAt: number,
  ): Promise<boolean> {
    const file = path.join(this.options.sessionsDir, `${sessionId}.jsonl`);
    const stat = fs.statSync(file);
    const inode = String(stat.ino);
    let row = await this.db.get<JournalRow>(
      "SELECT nonce, inode, offset, live FROM journals WHERE session_id = ?",
      sessionId,
    );
    // Recreated (another file) or rewritten shorter: index it again
    if (row && (row.inode !== inode || stat.size < row.offset)) {
      await this.drop(sessionId);
      row = undefined;
    }
    let offset = row?.offset ?? 0;
    while (offset < stat.size) {
      if (Date.now() - startedAt > SYNC_BUDGET_MS) {
        return false;
      }
      let parsed = parseJournalLines(
        readBytes(file, offset, Math.min(stat.size, offset + BATCH_BYTES)),
        offset,
      );
      if (parsed.end === offset && offset + BATCH_BYTES < stat.size) {
        // One line longer than a batch
        parsed = parseJournalLines(readBytes(file, offset, stat.size), offset);
      }
      if (parsed.end === offset) {
        // Only a line still being written
        return true;
      }
      const recreated = parsed.lines.some(
        ({ line }) =>
          line.t === "head" && row?.nonce && line.nonce !== row.nonce,
      );
      if (recreated) {
        await this.drop(sessionId);
        return this.syncJournal(sessionId, startedAt);
      }
      const ord = (
        await this.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM messages WHERE session_id = ?",
          sessionId,
        )
      )?.n;
      try {
        await this.db.transaction(
          (tx) =>
            this.applyBatch(tx, sessionId, inode, row, parsed, offset, ord!),
          { immediate: true },
        );
      } catch (e) {
        if (e instanceof SyncRace) {
          // Another process indexed this range first
          return true;
        }
        throw e;
      }
      offset = parsed.end;
      row = await this.db.get<JournalRow>(
        "SELECT nonce, inode, offset, live FROM journals WHERE session_id = ?",
        sessionId,
      );
    }
    return true;
  }

  private applyBatch(
    tx: SqliteTransaction,
    sessionId: string,
    inode: string,
    row: JournalRow | undefined,
    parsed: { lines: ParsedJournalLine[]; end: number },
    from: number,
    firstOrd: number,
  ): void {
    const claim = row
      ? tx.run(
          "UPDATE journals SET offset = ? WHERE session_id = ? AND offset = ?",
          parsed.end,
          sessionId,
          from,
        )
      : tx.run(
          "INSERT OR IGNORE INTO journals (session_id, inode, offset, live) VALUES (?, ?, ?, '[]')",
          sessionId,
          inode,
          parsed.end,
        );
    if (claim.changes === 0) {
      throw new SyncRace();
    }
    let live: number[] = row ? JSON.parse(row.live) : [];
    let nonce = row?.nonce ?? null;
    let workspace: string | null = null;
    let ord = firstOrd;
    const mark = (ids: number[], state: HistoryState) => {
      for (const id of ids) {
        tx.run("UPDATE messages SET state = ? WHERE id = ?", state, id);
      }
    };
    for (const { line, offset, length } of parsed.lines) {
      switch (line.t) {
        case "head":
          nonce = line.nonce;
          workspace = line.workspace ?? null;
          break;
        case "put": {
          // A put at i replaces the live items from i on
          mark(live.slice(line.i), "cut");
          live = live.slice(0, line.i);
          const id = Number(
            tx.run(
              "INSERT INTO messages (session_id, ord, role, tool, state, h, ts, byte_offset, byte_len) VALUES (?, ?, ?, ?, 'live', ?, ?, ?, ?)",
              sessionId,
              ord++,
              line.item.role,
              line.item.toolCalls?.[0]?.name ?? null,
              line.h,
              line.ts,
              offset,
              length,
            ).lastID,
          );
          const text = this.options.redact(itemText(line.item));
          for (
            let i = 0;
            i * CHUNK_CHARS < text.length && i < MAX_CHUNKS;
            i++
          ) {
            tx.run(
              `INSERT INTO ${this.text} (rowid, text) VALUES (?, ?)`,
              id * MAX_CHUNKS + i,
              text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
            );
          }
          live.push(id);
          break;
        }
        case "cut":
          mark(live.slice(line.n), "cut");
          live = live.slice(0, line.n);
          break;
        case "fold":
          mark(live.slice(line.from, line.n), "folded");
          live = [...live.slice(0, line.from), ...live.slice(line.n)];
          break;
        case "summary":
          // The turns it covers are indexed; the summary restates them
          break;
      }
    }
    tx.run(
      "UPDATE journals SET nonce = ?, live = ?, workspace = COALESCE(?, workspace) WHERE session_id = ?",
      nonce,
      JSON.stringify(live),
      workspace,
      sessionId,
    );
  }

  /**
   * Searches the transcripts of the given sessions, of one workspace, or all
   * of them. Undone (cut) items are left out; compacted ones are found.
   */
  async search(query: {
    text: string;
    sessionIds?: string[];
    workspace?: string;
    limit: number;
  }): Promise<HistorySearchResult> {
    const pending = await this.sync(query.sessionIds);
    const terms = query.text.split(/\s+/).filter(Boolean);
    if (!terms.length) {
      return { hits: [], basic: !this.fts, pending };
    }
    const where = [
      "m.state != 'cut'",
      `m.id = ${this.text}.rowid / ${MAX_CHUNKS}`,
    ];
    const params: (string | number)[] = [];
    if (query.sessionIds) {
      where.push(
        `m.session_id IN (${query.sessionIds.map(() => "?").join(", ")})`,
      );
      params.push(...query.sessionIds);
    }
    if (query.workspace) {
      where.push(
        "m.session_id IN (SELECT session_id FROM journals WHERE workspace = ?)",
      );
      params.push(query.workspace);
    }
    // Trigrams need 3 characters: shorter terms, and every term without
    // FTS5, match as substrings
    const matched = this.fts ? terms.filter((t) => t.length >= 3) : [];
    for (const term of terms.filter((t) => !matched.includes(t))) {
      where.push(`${this.text}.text LIKE ? ESCAPE '\\'`);
      params.push(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (matched.length) {
      where.push("history_fts MATCH ?");
      params.push(matched.map((t) => `"${t.replace(/"/g, '""')}"`).join(" "));
    }
    const rows = await this.db.all<
      {
        session_id: string;
        ord: number;
        role: string;
        tool: string | null;
        state: HistoryState;
        ts: number;
        h: string;
        snippet: string;
      }[]
    >(
      `SELECT m.session_id, m.ord, m.role, m.tool, m.state, m.ts, m.h,
         ${matched.length ? "snippet(history_fts, 0, '«', '»', '…', 16)" : `substr(${this.text}.text, 1, 200)`} AS snippet
       FROM ${this.text}, messages m
       WHERE ${where.join(" AND ")}
       ORDER BY ${matched.length ? "bm25(history_fts)" : "m.ts DESC"}
       LIMIT ?`,
      ...params,
      query.limit * 4,
    );
    // The same item again (a redo, a forked session) is one hit
    const seen = new Set<string>();
    const hits: HistoryHit[] = [];
    for (const row of rows) {
      if (hits.length === query.limit) {
        break;
      }
      if (!seen.has(row.h)) {
        seen.add(row.h);
        hits.push({
          sessionId: row.session_id,
          ord: row.ord,
          role: row.role,
          tool: row.tool ?? undefined,
          state: row.state,
          ts: row.ts,
          snippet: row.snippet,
        });
      }
    }
    return { hits, basic: !this.fts, pending };
  }

  /** Items `from` to `to` of a transcript, redacted */
  async read(
    sessionId: string,
    from: number,
    to: number,
  ): Promise<HistoryReadItem[]> {
    await this.sync([sessionId]);
    const rows = await this.db.all<
      {
        ord: number;
        state: HistoryState;
        ts: number;
        byte_offset: number;
        byte_len: number;
      }[]
    >(
      "SELECT ord, state, ts, byte_offset, byte_len FROM messages WHERE session_id = ? AND ord BETWEEN ? AND ? ORDER BY ord LIMIT ?",
      sessionId,
      from,
      to,
      READ_MAX_ITEMS,
    );
    const file = path.join(this.options.sessionsDir, `${sessionId}.jsonl`);
    const items: HistoryReadItem[] = [];
    let chars = 0;
    for (const row of rows) {
      const line = JSON.parse(
        readBytes(file, row.byte_offset, row.byte_offset + row.byte_len),
      ) as JournalLine;
      if (line.t !== "put") {
        continue;
      }
      const text = this.options.redact(
        `${line.item.role}: ${itemText(line.item)}`,
      );
      if (items.length && chars + text.length > READ_MAX_CHARS) {
        break;
      }
      chars += text.length;
      items.push({ ord: row.ord, state: row.state, ts: row.ts, text });
    }
    return items;
  }
}
