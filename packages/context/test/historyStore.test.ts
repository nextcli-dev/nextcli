import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  forgetJournal,
  syncJournal,
  type JournalSourceItem,
} from "../src/archive/index.js";
import { HistoryStore } from "../src/historyStore/index.js";
import { SqliteDatabase, sqliteHasFts5 } from "../src/sqlite.js";

let root: string;
let sessionsDir: string;
let dbPath: string;
const stores: HistoryStore[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "history-store-"));
  sessionsDir = path.join(root, "sessions");
  dbPath = path.join(root, "index", "history.sqlite");
  fs.mkdirSync(sessionsDir);
  forgetJournal();
});

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  fs.rmSync(root, { recursive: true, force: true });
});

const user = (content: string): JournalSourceItem => ({
  message: { role: "user", content },
  contextItems: [],
});
const reply = (content: string): JournalSourceItem => ({
  message: { role: "assistant", content },
  contextItems: [],
});
const read = (file: string, output: string): JournalSourceItem => ({
  message: { role: "assistant", content: "" },
  contextItems: [],
  toolCallStates: [
    {
      toolCallId: file,
      status: "done",
      toolCall: { function: { name: "Read", arguments: `{"path":"${file}"}` } },
      output: [{ content: output }],
    },
  ],
});
const summary = (text: string): JournalSourceItem => ({
  ...reply(text),
  conversationSummary: text,
});

function save(
  sessionId: string,
  history: JournalSourceItem[],
  workspace = "/repo",
) {
  syncJournal(path.join(sessionsDir, `${sessionId}.jsonl`), history, {
    workspace,
  });
}

const SECRET = "sk-plantedSecretValue123456";
const redact = (text: string) => text.split(SECRET).join("[redacted]");

async function open(fts: boolean) {
  const store = await HistoryStore.open({ dbPath, sessionsDir, redact, fts });
  stores.push(store);
  return store;
}

const modes = sqliteHasFts5() ? [true, false] : [false];

// Without FTS5 the store keeps its own file next to dbPath
const indexFile = (fts: boolean) =>
  fts ? dbPath : dbPath.replace(/\.sqlite$/, "-basic.sqlite");

async function indexedCount(fts: boolean, sessionId: string) {
  const db = await SqliteDatabase.open(indexFile(fts));
  try {
    return (await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE session_id = ?",
      sessionId,
    ))!.n;
  } finally {
    await db.close();
  }
}

describe.each(modes)("HistoryStore (fts: %s)", (fts) => {
  it("finds a path and an error from before cn's compaction", async () => {
    save("s1", [
      user("Fix the config loader"),
      read(
        "src/config/loadConfig.ts",
        "throws ENOENT_CONFIG_MISSING at line 42",
      ),
      reply("Fixed loadConfig"),
    ]);
    save("s1", [summary("Summary of the fix"), user("Continue")]);
    const store = await open(fts);

    const byPath = await store.search({ text: "loadConfig.ts", limit: 5 });
    const byError = await store.search({
      text: "ENOENT_CONFIG_MISSING",
      limit: 5,
    });

    expect(byPath.hits[0]).toMatchObject({
      sessionId: "s1",
      ord: 1,
      tool: "Read",
      state: "folded",
    });
    expect(byError.hits.map((h) => h.ord)).toEqual([1]);
    expect(byPath.basic).toBe(!fts);
  });

  it("leaves undone turns out of the results", async () => {
    save("s1", [user("first"), reply("keep this answer")]);
    save("s1", [user("first"), reply("keep this answer"), user("undone ask")]);
    save("s1", [user("first"), reply("keep this answer")]);
    const store = await open(fts);

    expect((await store.search({ text: "undone", limit: 5 })).hits).toEqual([]);
    expect(
      (await store.search({ text: "keep this", limit: 5 })).hits,
    ).toHaveLength(1);
  });

  it("indexes redacted text, so a secret is nowhere in the database", async () => {
    save("s1", [user(`export OPENAI_API_KEY=${SECRET} then run it`)]);
    const store = await open(fts);

    const result = await store.search({ text: "export", limit: 5 });
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    expect(result.hits[0].snippet).not.toContain(SECRET);
    for (const file of fs.readdirSync(path.dirname(dbPath))) {
      const bytes = fs.readFileSync(path.join(path.dirname(dbPath), file));
      expect(bytes.includes(SECRET)).toBe(false);
    }
  });

  it("keeps ordinary text whole while redacting", async () => {
    save("s1", [user("move the desk-lamp test into src/task-runner.ts")]);
    const store = await open(fts);

    const result = await store.search({ text: "desk-lamp", limit: 5 });

    expect(result.hits).toHaveLength(1);
  });

  it("forgets a session whose transcript was deleted", async () => {
    save("s1", [user("a unique phrase here")]);
    const store = await open(fts);
    expect(
      (await store.search({ text: "unique phrase", limit: 5 })).hits,
    ).toHaveLength(1);

    fs.unlinkSync(path.join(sessionsDir, "s1.jsonl"));

    expect(
      (await store.search({ text: "unique phrase", limit: 5 })).hits,
    ).toEqual([]);
  });

  it("indexes each line once when two processes sync at the same time", async () => {
    save("s1", [user("alpha one"), reply("beta two"), user("gamma three")]);
    const [a, b] = [await open(fts), await open(fts)];

    await Promise.all([a.sync(), b.sync()]);
    save("s1", [
      user("alpha one"),
      reply("beta two"),
      user("gamma three"),
      reply("delta four"),
    ]);
    await Promise.all([a.sync(), b.sync()]);

    const { items } = await a.read("s1", 0, 100);
    expect(items.map((i) => i.ord)).toEqual([0, 1, 2, 3]);
  });

  it("indexes a recreated transcript again", async () => {
    save("s1", [user("from the old transcript")]);
    const store = await open(fts);
    await store.sync();

    fs.unlinkSync(path.join(sessionsDir, "s1.jsonl"));
    forgetJournal();
    save("s1", [user("from the new transcript")]);

    expect(
      (await store.search({ text: "old transcript", limit: 5 })).hits,
    ).toEqual([]);
    expect(
      (await store.search({ text: "new transcript", limit: 5 })).hits,
    ).toHaveLength(1);
  });

  it("indexes a transcript recreated on the same inode and size again", async () => {
    // Linux hands a deleted file's inode to the next file at once
    const file = path.join(sessionsDir, "s1.jsonl");
    const kept = path.join(root, "kept.jsonl");
    save("s1", [user("from the old transcript")]);
    const store = await open(fts);
    await store.sync();

    fs.renameSync(file, kept);
    forgetJournal();
    save("s1", [user("from the new transcript")]);
    const recreated = fs.readFileSync(file);
    fs.unlinkSync(file);
    fs.renameSync(kept, file);
    const inode = fs.statSync(file).ino;
    fs.writeFileSync(file, recreated);
    expect(fs.statSync(file).ino).toBe(inode);

    expect(
      (await store.search({ text: "old transcript", limit: 5 })).hits,
    ).toEqual([]);
    expect(
      (await store.search({ text: "new transcript", limit: 5 })).hits,
    ).toHaveLength(1);
  });

  it("searches one workspace's sessions", async () => {
    save("s1", [user("shared word in repo A")], "/repo-a");
    save("s2", [user("shared word in repo B")], "/repo-b");
    const store = await open(fts);

    const result = await store.search({
      text: "shared word",
      workspace: "/repo-b",
      limit: 5,
    });

    expect(result.hits.map((h) => h.sessionId)).toEqual(["s2"]);
  });

  it("matches a short term as a substring", async () => {
    save("s1", [
      user("exit code 42 from the build"),
      reply("the build passed"),
    ]);
    const store = await open(fts);

    const result = await store.search({ text: "42 build", limit: 5 });

    expect(result.hits.map((h) => h.ord)).toEqual([0]);
  });

  it("reads turns back in order, redacted, with compacted ones marked", async () => {
    save("s1", [user(`key ${SECRET}`), reply("noted")]);
    save("s1", [summary("Summary"), user("Continue")]);
    const store = await open(fts);

    const { items } = await store.read("s1", 0, 10);

    expect(items.map((i) => [i.ord, i.state])).toEqual([
      [0, "folded"],
      [1, "folded"],
      [2, "live"],
      [3, "live"],
    ]);
    expect(items[0].text).toBe("user: key [redacted]");
  });

  it("reports a transcript indexed only once it is, when another process took a batch", async () => {
    // Three batches of one item each
    const big = (n: number) => user(`item ${n} ${"x".repeat(600_000)}`);
    save("s1", [big(0), big(1), big(2)]);
    const [a, b] = [await open(fts), await open(fts)];
    const syncAndCount = async (store: HistoryStore) => ({
      pending: await store.sync(),
      indexed: await indexedCount(fts, "s1"),
    });

    const results = await Promise.all([syncAndCount(a), syncAndCount(b)]);

    for (const { pending, indexed } of results) {
      expect(pending === 0 ? indexed : 3).toBe(3);
    }
  });

  it("finds an item whose terms are in different chunks", async () => {
    const log = `build started\n${"noise ".repeat(2_000)}\nexit code 42`;
    save("s1", [user("run it"), read("build.log", log)]);
    const store = await open(fts);

    const result = await store.search({ text: "started exit 42", limit: 5 });

    expect(result.hits.map((h) => h.ord)).toEqual([1]);
  });

  it("returns other items when one long output matches in every chunk", async () => {
    const noisy = Array.from(
      { length: 10 },
      () => `error ${"y".repeat(7_990)}`,
    ).join("");
    // The long output is the newest item, so it comes first without FTS5
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000);
      save("s1", [user("an error in the config")]);
      vi.setSystemTime(2_000);
      save("s1", [user("an error in the config"), read("noisy.log", noisy)]);
    } finally {
      vi.useRealTimers();
    }
    const store = await open(fts);

    const result = await store.search({ text: "error", limit: 2 });

    expect(result.hits.map((h) => h.ord).sort()).toEqual([0, 1]);
  });

  it("shows each time a session said the same thing", async () => {
    save("s1", [user("run the tests"), reply("ok"), user("run the tests")]);
    const store = await open(fts);

    const result = await store.search({ text: "run the tests", limit: 5 });

    expect(result.hits.map((h) => h.ord).sort()).toEqual([0, 2]);
  });

  it("shows a forked item from the newest session", async () => {
    save("s1", [user("the forked requirement"), reply("ok")]);
    save("s2", [user("the forked requirement"), reply("ok")]);
    const store = await open(fts);

    const result = await store.search({ text: "forked requirement", limit: 5 });

    expect(result.hits.map((h) => h.sessionId)).toEqual(["s2"]);
  });

  it("finds and reads a summary VS Code set on an existing message", async () => {
    const turns = [user("fix the importer"), reply("fixed it")];
    save("s1", turns);
    save("s1", [
      turns[0],
      {
        ...turns[1],
        conversationSummary: "The importer skipped zanzibar rows",
      },
    ]);
    const store = await open(fts);

    const found = await store.search({ text: "zanzibar", limit: 5 });
    const { items } = await store.read("s1", 1, 1);
    save("s1", turns);
    const afterRemoval = await store.search({ text: "zanzibar", limit: 5 });

    expect(found.hits.map((h) => h.ord)).toEqual([1]);
    expect(items[0].text).toContain("The importer skipped zanzibar rows");
    expect(afterRemoval.hits).toEqual([]);
  });

  it("says a read is pending when the index is busy", async () => {
    save("s1", [user("a turn not indexed yet")]);
    const store = await open(fts);
    const other = await SqliteDatabase.open(indexFile(fts));
    await other.exec("BEGIN IMMEDIATE");
    try {
      const result = await store.read("s1", 0, 10);

      expect(result).toEqual({ items: [], pending: true });
    } finally {
      await other.exec("ROLLBACK");
      await other.close();
    }
    expect((await store.read("s1", 0, 10)).pending).toBe(false);
  });

  it("counts a deleted session it couldn't forget while busy as pending", async () => {
    save("s1", [user("a session about to be deleted")]);
    const store = await open(fts);
    await store.sync();
    fs.unlinkSync(path.join(sessionsDir, "s1.jsonl"));
    const other = await SqliteDatabase.open(indexFile(fts));
    await other.exec("BEGIN IMMEDIATE");
    try {
      expect(await store.sync()).toBe(1);
    } finally {
      await other.exec("ROLLBACK");
      await other.close();
    }
    expect(await store.sync()).toBe(0);
  });

  it("cuts one item longer than a read short", async () => {
    save("s1", [read("huge.log", "z".repeat(200_000))]);
    const store = await open(fts);

    const { items } = await store.read("s1", 0, 0);

    expect(items[0].text.length).toBeLessThan(81_000);
    expect(items[0].text).toMatch(/more characters not shown$/);
  });

  it("leaves no text of a deleted session in the database files", async () => {
    save("s1", [user("quokka-marker-in-a-deleted-session")]);
    const store = await open(fts);
    await store.sync();

    fs.unlinkSync(path.join(sessionsDir, "s1.jsonl"));
    await store.sync();

    // While the store is still open, as a VS Code window keeps it: closing
    // would checkpoint the WAL anyway
    for (const file of fs.readdirSync(path.dirname(dbPath))) {
      const bytes = fs.readFileSync(path.join(path.dirname(dbPath), file));
      expect(bytes.includes("quokka-marker")).toBe(false);
    }
  });
});

describe.skipIf(!sqliteHasFts5())("HistoryStore across search modes", () => {
  it("finds items another process indexed without FTS5, and the reverse", async () => {
    save("s1", [user("indexed by the full-text process")]);
    const full = await open(true);
    await full.sync();
    save("s1", [
      user("indexed by the full-text process"),
      reply("indexed by the basic process"),
    ]);
    const basic = await open(false);
    await basic.sync();

    for (const store of [full, basic]) {
      for (const text of ["full-text process", "basic process"]) {
        expect((await store.search({ text, limit: 5 })).hits).toHaveLength(1);
      }
    }
  });
});
