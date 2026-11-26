import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseJournalLines,
  type JournalLine,
  type ParsedJournalLine,
  type StoredItem,
} from "../archive/journal.js";
import { readJournalHead } from "../archive/sync.js";
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
  /**
   * A partial match: the query's words this item lacks. Unset when it has
   * every word.
   */
  missing?: string[];
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
  /**
   * The read stopped at its size limit before `to`: the first position it
   * didn't return, to read from next
   */
  next?: number;
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
/**
 * The layout of the index. An index of another version is dropped and built
 * again from the transcripts: it is a cache of them.
 */
const SCHEMA_VERSION = 1;
const READ_MAX_CHARS = 80_000;

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

/**
 * Common English words a search skips: they are in nearly every item, so
 * requiring them hides real matches and counting them ranks noise. Negations
 * stay, since they matter in error messages.
 */
const STOP_WORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has " +
    "have how i if in into is it its me my of on or our so than that the their " +
    "them then there these they this those to us was we were what when where " +
    "which who why will with would you your"
  ).split(" "),
);
const MAX_TERMS = 16;

/**
 * The words of a query a search looks for. `terms` are what a full hit holds;
 * `counted`, the terms of 3 or more characters, are what makes an item a
 * partial hit and ranks it. A query of stop words only keeps them all and
 * has no partial hits.
 */
function searchTerms(text: string): { terms: string[]; counted: string[] } {
  const seen = new Set<string>();
  const all: string[] = [];
  for (const raw of text.split(/\s+/)) {
    // Phrases aren't supported: a quoted phrase is its words
    const term = raw.replace(/^["']+|["']+$/g, "");
    const key = term.toLowerCase();
    if (term && !seen.has(key) && all.length < MAX_TERMS) {
      seen.add(key);
      all.push(term);
    }
  }
  const meaningful = all.filter((t) => !STOP_WORDS.has(t.toLowerCase()));
  return meaningful.length
    ? { terms: meaningful, counted: meaningful.filter((t) => t.length >= 3) }
    : { terms: all, counted: [] };
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
 * One form of a workspace, whichever host recorded it, so a folder's sessions
 * match: cn records a path (process.cwd()), VS Code a file:// URI,
 * percent-encoded. Symlinks are resolved, and case is folded where file
 * systems ignore it by default (macOS, Windows). Another kind of URI (a
 * remote workspace) is kept as it is.
 */
export function workspaceKey(workspace: string): string {
  let dir = workspace;
  if (/^file:/i.test(dir)) {
    try {
      dir = fileURLToPath(dir);
    } catch {
      return workspace;
    }
  } else if (/^[a-z][\w+.-]*:\/\//i.test(dir)) {
    return workspace;
  }
  dir = path.resolve(dir);
  try {
    dir = fs.realpathSync.native(dir);
  } catch {
    // Gone: compared as written
  }
  return process.platform === "darwin" || process.platform === "win32"
    ? dir.toLowerCase()
    : dir;
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
    const version =
      (await db.get<{ user_version: number }>("PRAGMA user_version"))
        ?.user_version ?? 0;
    if (version !== SCHEMA_VERSION) {
      await db.exec(`
        DROP TABLE IF EXISTS journals;
        DROP TABLE IF EXISTS messages;
        DROP TABLE IF EXISTS history_text;
        ${fts ? "DROP TABLE IF EXISTS history_fts;" : ""}
      `);
    }
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
    if (version !== SCHEMA_VERSION) {
      await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
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
    const head = row?.nonce ? readJournalHead(file)?.nonce : undefined;
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
      const head = parsed.lines.find(({ line }) => line.t === "head")?.line;
      const workspace =
        head?.t === "head" && head.workspace
          ? workspaceKey(head.workspace)
          : null;
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
              workspace,
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
      /** The head's workspace as workspaceKey gives it */
      workspace: string | null;
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
          workspace = batch.workspace;
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
   * Searches the transcripts of the given sessions, of some workspaces, or
   * all of them. Items with every word of the query come first; if there are
   * fewer than `limit`, items with some of its words fill the rest, ranked by
   * how many they have, each with the words it lacks. Words match anywhere in
   * an item, in any of its chunks; common words are skipped (STOP_WORDS).
   * Undone (cut) items are left out; compacted ones are found. The same item
   * in several sessions (a fork copies its source) is one hit, the newest
   * copy.
   */
  async search(query: {
    text: string;
    sessionIds?: string[];
    /** A folder, or several (a multi-root window): a path or a URI */
    workspace?: string | string[];
    limit: number;
  }): Promise<HistorySearchResult> {
    const pending = await this.sync(query.sessionIds);
    const { terms, counted } = searchTerms(query.text);
    if (!terms.length) {
      return { hits: [], basic: !this.fts, pending };
    }
    const params: (string | number)[] = [];
    // The items searched, before any text is touched
    const scope = ["m.state != 'cut'"];
    if (query.sessionIds) {
      scope.push(
        `m.session_id IN (${query.sessionIds.map(() => "?").join(", ")})`,
      );
      params.push(...query.sessionIds);
    }
    if (query.workspace !== undefined) {
      const keys = [query.workspace].flat().map(workspaceKey);
      scope.push(
        `m.session_id IN (SELECT session_id FROM journals WHERE workspace IN (${keys.map(() => "?").join(", ")}))`,
      );
      params.push(...keys);
    }
    // Candidates: chunks with any of the words. Trigrams need 3 characters,
    // so shorter terms, and every term without FTS5, match as substrings
    const ranked = counted.length ? counted : terms;
    const matched = this.fts ? ranked.filter((t) => t.length >= 3) : [];
    let chunks: string;
    if (matched.length) {
      chunks = `SELECT rowid / ${MAX_CHUNKS} AS id, rowid AS chunk, bm25(history_fts) AS score
        FROM history_fts WHERE history_fts MATCH ? AND rowid / ${MAX_CHUNKS} IN scope`;
      params.push(matched.map(quoteTerm).join(" OR "));
    } else {
      chunks = `SELECT t.rowid / ${MAX_CHUNKS} AS id, t.rowid AS chunk, t.rowid AS score
        FROM scope s JOIN ${this.text} t
          ON t.rowid >= s.id * ${MAX_CHUNKS} AND t.rowid < (s.id + 1) * ${MAX_CHUNKS}
        WHERE ${ranked.map(() => "t.text LIKE ? ESCAPE '\\'").join(" OR ")}`;
      params.push(...ranked.map(likeTerm));
    }
    // One flag per term: whether the item holds it, in any chunk
    const flags = terms.map((term, i) => {
      if (this.fts && term.length >= 3) {
        params.push(quoteTerm(term));
        return `id IN (SELECT rowid / ${MAX_CHUNKS} FROM history_fts
          WHERE history_fts MATCH ? AND rowid / ${MAX_CHUNKS} IN scope) AS t${i}`;
      }
      params.push(likeTerm(term));
      return `EXISTS (SELECT 1 FROM ${this.text}
          WHERE rowid >= best.id * ${MAX_CHUNKS} AND rowid < (best.id + 1) * ${MAX_CHUNKS}
            AND text LIKE ? ESCAPE '\\') AS t${i}`;
    });
    const full = terms.map((_, i) => `f.t${i}`).join(" AND ");
    // Sort keys are expressions over the materialized flags: an alias would
    // run the subqueries again, and a bare 0 would be read as a column
    const order = [`(${full}) DESC`];
    if (counted.length) {
      order.push(
        `(${counted.map((c) => `f.t${terms.indexOf(c)}`).join(" + ")}) DESC`,
      );
    }
    order.push(
      ...(matched.length ? ["f.score"] : []),
      "m.ts DESC",
      "m.id DESC",
    );
    const sql = `WITH scope AS MATERIALIZED (
          SELECT m.id FROM messages m WHERE ${scope.join(" AND ")}),
        chunks AS MATERIALIZED (${chunks}),
        best AS (SELECT id, MIN(score) AS score, chunk FROM chunks GROUP BY id),
        flagged AS MATERIALIZED (SELECT id, score, chunk, ${flags.join(", ")} FROM best)
      SELECT m.id, m.session_id, m.ord, m.role, m.tool, m.state, m.ts, m.h, f.chunk,
        ${terms.map((_, i) => `f.t${i}`).join(", ")}
      FROM flagged f JOIN messages m ON m.id = f.id
      ${counted.length ? "" : `WHERE ${full}`}
      ORDER BY ${order.join(", ")}
      LIMIT ? OFFSET ?`;
    const page = query.limit * 4;
    // Which session's copy of an item is shown: the first, the newest
    const shown = new Map<string, string>();
    const seen = new Set<number>();
    const hits: (HistoryHit & { chunk: number })[] = [];
    for (let offset = 0; hits.length < query.limit; offset += page) {
      const rows = await this.db.all<
        ({
          id: number;
          session_id: string;
          ord: number;
          role: string;
          tool: string | null;
          state: HistoryState;
          ts: number;
          h: string;
          chunk: number;
        } & Record<string, number>)[]
      >(sql, ...params, page, offset);
      for (const row of rows) {
        const owner = shown.get(row.h);
        if (
          seen.has(row.id) ||
          (owner !== undefined && owner !== row.session_id)
        ) {
          continue;
        }
        seen.add(row.id);
        shown.set(row.h, row.session_id);
        const missing = terms.filter((_, i) => !row[`t${i}`]);
        hits.push({
          sessionId: row.session_id,
          ord: row.ord,
          role: row.role,
          tool: row.tool ?? undefined,
          state: row.state,
          ts: row.ts,
          snippet: "",
          ...(missing.length ? { missing } : {}),
          chunk: row.chunk,
        });
        if (hits.length === query.limit) {
          break;
        }
      }
      if (rows.length < page) {
        break;
      }
    }
    // Snippets only for what is returned: computing them for every
    // candidate chunk made a search with common words take seconds
    for (const hit of hits) {
      hit.snippet = await this.snippet(hit.chunk, terms, matched);
    }
    return {
      hits: hits.map(({ chunk: _, ...hit }) => hit),
      basic: !this.fts,
      pending,
    };
  }

  /** Text around the query's words in one chunk */
  private async snippet(
    chunk: number,
    terms: string[],
    matched: string[],
  ): Promise<string> {
    if (matched.length) {
      // The wrapper binds a rowid past 2^31 as REAL, and FTS5 ignores a REAL
      // rowid next to MATCH
      const row = await this.db.get<{ s: string }>(
        `SELECT snippet(history_fts, 0, '«', '»', '…', 16) AS s FROM history_fts
          WHERE history_fts MATCH ? AND rowid = CAST(? AS INTEGER)`,
        matched.map(quoteTerm).join(" OR "),
        chunk,
      );
      if (row?.s) {
        return row.s;
      }
    }
    const text =
      (
        await this.db.get<{ text: string }>(
          `SELECT text FROM ${this.text} WHERE rowid = CAST(? AS INTEGER)`,
          chunk,
        )
      )?.text ?? "";
    // Around the earliest word the chunk holds, not just the first one asked
    const lower = text.toLowerCase();
    const at = terms
      .map((t) => lower.indexOf(t.toLowerCase()))
      .filter((i) => i >= 0);
    const start = at.length ? Math.max(0, Math.min(...at) - 80) : 0;
    return text.slice(start, start + 200);
  }

  /**
   * Items `from` to `to` of a transcript, redacted, with any summary set on
   * them. Undone (cut) items are left out; compacted ones are marked. At
   * most READ_MAX_ITEMS and about READ_MAX_CHARS, with `next` set when that
   * stopped it before `to`; a first item longer than that is cut short.
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
      // Undone (cut) items stay out, as in search: an undo took them out of
      // the conversation, and a read would put them back in the prompt
      "SELECT id, ord, state, ts, byte_offset, byte_len FROM messages WHERE session_id = ? AND ord BETWEEN ? AND ? AND state != 'cut' ORDER BY ord LIMIT ?",
      sessionId,
      from,
      to,
      // One more, to tell whether the limit stopped the read
      READ_MAX_ITEMS + 1,
    );
    let next =
      rows.length > READ_MAX_ITEMS
        ? rows.pop()!.ord
        : (undefined as number | undefined);
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
          next = row.ord;
          break;
        }
        const more = text.length - READ_MAX_CHARS;
        text = `${text.slice(0, READ_MAX_CHARS)}\n… ${more} more characters not shown`;
      }
      chars += text.length;
      items.push({ ord: row.ord, state: row.state, ts: row.ts, text });
    }
    return { items, pending, ...(next === undefined ? {} : { next }) };
  }
}
