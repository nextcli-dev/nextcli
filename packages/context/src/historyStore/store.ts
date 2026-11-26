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

export interface HistoryReadResult {
  items: HistoryReadItem[];
  /** The transcript isn't indexed to its end yet (busy, or out of time) */
  pending: boolean;
}

export interface HistoryStoreOptions {
  /**
   * The index database; keep it outside the sessions folder. Without FTS5
   * the index is `<name>-basic.sqlite` next to it: the two modes keep text in
   * different tables, so cn and VS Code on Node builds that differ each keep
   * their own instead of sharing offsets over tables only one of them fills.
   */
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
// chunks are one rowid range. A summary set on an existing item (VS Code's
// compaction) takes the chunks from SUMMARY_CHUNK on
const MAX_CHUNKS = 1_000;
const SUMMARY_CHUNK = 900;
const BATCH_BYTES = 1_000_000;
const SYNC_BUDGET_MS = 300;
const READ_MAX_ITEMS = 40;
const READ_MAX_CHARS = 80_000;
/** Enough for a head line: a nonce and a workspace path */
const HEAD_BYTES = 8192;

class SyncRace extends Error {}

const isBusy = (e: unknown) => (e as { code?: string }).code === "SQLITE_BUSY";

/**
 * Whether `work` got to the end: false when it says it didn't, or when the
 * database was busy. Either way the session counts as pending.
 */
async function finished(work: () => Promise<boolean>): Promise<boolean> {
  try {
    return await work();
  } catch (e) {
    if (!isBusy(e)) {
      throw e;
    }
    return false;
  }
}

const quoteTerm = (term: string) => `"${term.replace(/"/g, '""')}"`;
const likeTerm = (term: string) =>
  `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Redacted texts of a batch's lines by byte offset, made before the lock */
type BatchTexts = Map<number, { text: string; summary?: string }>;

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

/**
 * A summary the item's text doesn't already hold: VS Code sets one on an
 * existing message, while cn's summary message is its content
 */
function extraSummary(item: StoredItem): string | undefined {
  return item.summary && item.summary !== item.content
    ? item.summary
    : undefined;
}

function readBytes(file: string, start: number, end: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

/** The nonce on a transcript's head line, if its first line is one */
function headNonce(file: string, size: number): string | undefined {
  const { lines } = parseJournalLines(
    readBytes(file, 0, Math.min(size, HEAD_BYTES)),
  );
  const first = lines[0]?.line;
  return first?.t === "head" ? first.nonce : undefined;
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
    const fts = options.fts ?? sqliteHasFts5();
    const file = fts
      ? options.dbPath
      : options.dbPath.replace(/(\.sqlite)?$/, "-basic$1");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = await SqliteDatabase.open(file);
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
    if (fts) {
      try {
        // A deleted session's terms leave FTS5's index at once, not at its
        // next segment merge
        await db.exec(
          "INSERT INTO history_fts (history_fts, rank) VALUES ('secure-delete', 1)",
        );
      } catch {
        // SQLite before 3.42, or busy: set by the next open
      }
    }
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
    let pending = 0;
    for (const { session_id } of indexed) {
      if (
        !present.has(session_id) &&
        !(await finished(() => this.drop(session_id).then(() => true)))
      ) {
        pending++;
      }
    }
    const startedAt = Date.now();
    for (const sessionId of sessionIds ?? present) {
      if (!present.has(sessionId)) {
        continue;
      }
      if (!(await finished(() => this.syncJournal(sessionId, startedAt)))) {
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
    // secure_delete zeroes the freed pages; until a checkpoint the WAL still
    // holds the text
    try {
      await this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Busy: the next one does it
    }
  }

  private journalRow(sessionId: string): Promise<JournalRow | undefined> {
    return this.db.get<JournalRow>(
      "SELECT nonce, inode, offset, live FROM journals WHERE session_id = ?",
      sessionId,
    );
  }

  /** Whether the transcript is indexed to its end */
  private async syncJournal(
    sessionId: string,
    startedAt: number,
  ): Promise<boolean> {
    const file = path.join(this.options.sessionsDir, `${sessionId}.jsonl`);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) {
      // Deleted since the folder was listed: the next sync forgets it
      return true;
    }
    const inode = String(stat.ino);
    let row = await this.journalRow(sessionId);
    // Recreated or rewritten: index it again. Linux gives a deleted file's
    // inode to the next file, and the new one can be as long, so the head's
    // nonce is what tells them apart
    const head = row?.nonce ? headNonce(file, stat.size) : undefined;
    if (
      row &&
      (row.inode !== inode ||
        stat.size < row.offset ||
        (head !== undefined && head !== row.nonce))
    ) {
      await this.drop(sessionId);
      row = undefined;
    }
    while ((row?.offset ?? 0) < stat.size) {
      const offset = row?.offset ?? 0;
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
      const texts = this.redactBatch(parsed.lines);
      const ord = (
        await this.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM messages WHERE session_id = ?",
          sessionId,
        )
      )?.n;
      try {
        await this.db.transaction(
          (tx) =>
            this.applyBatch(tx, {
              sessionId,
              inode,
              row,
              parsed,
              from: offset,
              firstOrd: ord!,
              texts,
            }),
          { immediate: true },
        );
      } catch (e) {
        // Another process indexed this range first. It may have stopped
        // there (its own budget), so go on from where it got to
        if (!(e instanceof SyncRace)) {
          throw e;
        }
      }
      row = await this.journalRow(sessionId);
    }
    return true;
  }

  private redactBatch(lines: ParsedJournalLine[]): BatchTexts {
    const { redact } = this.options;
    const texts: BatchTexts = new Map();
    for (const { line, offset } of lines) {
      if (line.t === "put") {
        const summary = extraSummary(line.item);
        texts.set(offset, {
          text: redact(itemText(line.item)),
          summary: summary === undefined ? undefined : redact(summary),
        });
      } else if (line.t === "summary" && line.text) {
        texts.set(offset, { text: redact(line.text) });
      }
    }
    return texts;
  }

  /** Chunks of `text` into rowids `first` up to `end` of message `id` */
  private insertChunks(
    tx: SqliteTransaction,
    id: number,
    first: number,
    end: number,
    text: string,
  ): void {
    for (let i = 0; i * CHUNK_CHARS < text.length && first + i < end; i++) {
      tx.run(
        `INSERT INTO ${this.text} (rowid, text) VALUES (?, ?)`,
        id * MAX_CHUNKS + first + i,
        text.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
      );
    }
  }

  private applyBatch(
    tx: SqliteTransaction,
    batch: {
      sessionId: string;
      inode: string;
      row: JournalRow | undefined;
      parsed: { lines: ParsedJournalLine[]; end: number };
      from: number;
      firstOrd: number;
      texts: BatchTexts;
    },
  ): void {
    const { sessionId, inode, row, parsed, from, firstOrd, texts } = batch;
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
          const { text, summary } = texts.get(offset)!;
          this.insertChunks(tx, id, 0, SUMMARY_CHUNK, text);
          if (summary) {
            this.insertChunks(tx, id, SUMMARY_CHUNK, MAX_CHUNKS, summary);
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
        case "summary": {
          // VS Code set or removed a summary on an existing message
          const id = live[line.i];
          if (id === undefined) {
            break;
          }
          tx.run(
            `DELETE FROM ${this.text} WHERE rowid >= ? AND rowid < ?`,
            id * MAX_CHUNKS + SUMMARY_CHUNK,
            (id + 1) * MAX_CHUNKS,
          );
          const summary = texts.get(offset)?.text;
          if (summary) {
            this.insertChunks(tx, id, SUMMARY_CHUNK, MAX_CHUNKS, summary);
          }
          break;
        }
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
   * of them. Every term must be in the item, in any of its chunks. Undone
   * (cut) items are left out; compacted ones are found. The same item in
   * several sessions (a fork copies its source) is one hit, the newest copy.
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
    const where = ["m.state != 'cut'"];
    const whereParams: string[] = [];
    if (query.sessionIds) {
      where.push(
        `m.session_id IN (${query.sessionIds.map(() => "?").join(", ")})`,
      );
      whereParams.push(...query.sessionIds);
    }
    if (query.workspace) {
      where.push(
        "m.session_id IN (SELECT session_id FROM journals WHERE workspace = ?)",
      );
      whereParams.push(query.workspace);
    }
    // Trigrams need 3 characters: shorter terms, and every term without
    // FTS5, match as substrings
    const words = this.fts ? terms.filter((t) => t.length >= 3) : [];
    const messageOf = `rowid / ${MAX_CHUNKS}`;
    for (const term of terms) {
      if (words.includes(term)) {
        where.push(
          `m.id IN (SELECT ${messageOf} FROM history_fts WHERE history_fts MATCH ?)`,
        );
        whereParams.push(quoteTerm(term));
      } else {
        where.push(
          `m.id IN (SELECT ${messageOf} FROM ${this.text} WHERE text LIKE ? ESCAPE '\\')`,
        );
        whereParams.push(likeTerm(term));
      }
    }
    // Each item's best chunk (by bm25; without full-text terms, its first
    // matching chunk) gives its rank and its snippet. bm25 can't run inside
    // an aggregate, so chunks are scored first; SQLite then takes the
    // snippet from the row MIN picks
    const chunks = words.length
      ? {
          sql: `SELECT ${messageOf} AS id, bm25(history_fts) AS score,
                  snippet(history_fts, 0, '«', '»', '…', 16) AS snippet
                FROM history_fts WHERE history_fts MATCH ?`,
          params: [words.map(quoteTerm).join(" OR ")],
          order: "best.score, m.ts DESC, m.id DESC",
        }
      : {
          sql: `SELECT ${messageOf} AS id, rowid AS score,
                  substr(text, max(1, instr(lower(text), lower(?)) - 80), 200) AS snippet
                FROM ${this.text} WHERE text LIKE ? ESCAPE '\\'`,
          params: [terms[0], likeTerm(terms[0])],
          order: "m.ts DESC, m.id DESC",
        };
    const sql = `WITH chunks AS MATERIALIZED (${chunks.sql}),
        best AS (SELECT id, MIN(score) AS score, snippet FROM chunks GROUP BY id)
      SELECT m.session_id, m.ord, m.role, m.tool, m.state, m.ts, m.h, best.snippet
      FROM best JOIN messages m ON m.id = best.id
      WHERE ${where.join(" AND ")}
      ORDER BY ${chunks.order}
      LIMIT ? OFFSET ?`;
    const page = query.limit * 4;
    // Which session's copy of an item is shown: the first, the newest
    const shown = new Map<string, string>();
    const hits: HistoryHit[] = [];
    for (let offset = 0; hits.length < query.limit; offset += page) {
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
      >(sql, ...chunks.params, ...whereParams, page, offset);
      for (const row of rows) {
        const owner = shown.get(row.h);
        if (owner !== undefined && owner !== row.session_id) {
          continue;
        }
        shown.set(row.h, row.session_id);
        hits.push({
          sessionId: row.session_id,
          ord: row.ord,
          role: row.role,
          tool: row.tool ?? undefined,
          state: row.state,
          ts: row.ts,
          snippet: row.snippet,
        });
        if (hits.length === query.limit) {
          break;
        }
      }
      if (rows.length < page) {
        break;
      }
    }
    return { hits, basic: !this.fts, pending };
  }

  /**
   * Items `from` to `to` of a transcript, redacted, with any summary set on
   * them. At most READ_MAX_ITEMS and about READ_MAX_CHARS: a first item
   * longer than that is cut short.
   */
  async read(
    sessionId: string,
    from: number,
    to: number,
  ): Promise<HistoryReadResult> {
    let pending = (await this.sync([sessionId])) > 0;
    const rows = await this.db.all<
      {
        id: number;
        ord: number;
        state: HistoryState;
        ts: number;
        byte_offset: number;
        byte_len: number;
      }[]
    >(
      "SELECT id, ord, state, ts, byte_offset, byte_len FROM messages WHERE session_id = ? AND ord BETWEEN ? AND ? ORDER BY ord LIMIT ?",
      sessionId,
      from,
      to,
      READ_MAX_ITEMS,
    );
    const file = path.join(this.options.sessionsDir, `${sessionId}.jsonl`);
    const items: HistoryReadItem[] = [];
    let chars = 0;
    for (const row of rows) {
      let line: JournalLine;
      try {
        line = JSON.parse(
          readBytes(
            file,
            row.byte_offset,
            row.byte_offset + row.byte_len,
          ).toString("utf8"),
        ) as JournalLine;
      } catch {
        // The transcript is gone, or was rewritten since it was indexed
        // (deleted while the index was busy, or replaced after this sync):
        // the index no longer describes it until the next sync
        pending = true;
        break;
      }
      if (line.t !== "put") {
        continue;
      }
      let text = this.options.redact(
        `${line.item.role}: ${itemText(line.item)}`,
      );
      const summary = (
        await this.db.all<{ text: string }[]>(
          `SELECT text FROM ${this.text} WHERE rowid >= ? AND rowid < ? ORDER BY rowid`,
          row.id * MAX_CHUNKS + SUMMARY_CHUNK,
          (row.id + 1) * MAX_CHUNKS,
        )
      )
        .map((c) => c.text)
        .join("");
      if (summary) {
        text += `\nSummary of the conversation up to here: ${summary}`;
      }
      if (chars + text.length > READ_MAX_CHARS) {
        if (items.length) {
          break;
        }
        const more = text.length - READ_MAX_CHARS;
        text = `${text.slice(0, READ_MAX_CHARS)}\n… ${more} more characters not shown`;
      }
      chars += text.length;
      items.push({ ord: row.ord, state: row.state, ts: row.ts, text });
    }
    return { items, pending };
  }
}
