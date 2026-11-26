import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

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
    save("s1", [user("from the zanzibar transcript")]);
    const store = await open(fts);
    await store.sync();

    fs.unlinkSync(path.join(sessionsDir, "s1.jsonl"));
    forgetJournal();
    save("s1", [user("from the kalahari transcript")]);

    expect((await store.search({ text: "zanzibar", limit: 5 })).hits).toEqual(
      [],
    );
    expect(
      (await store.search({ text: "kalahari", limit: 5 })).hits,
    ).toHaveLength(1);
  });

  it("indexes a transcript recreated on the same inode and size again", async () => {
    // Linux hands a deleted file's inode to the next file at once
    const file = path.join(sessionsDir, "s1.jsonl");
    const kept = path.join(root, "kept.jsonl");
    save("s1", [user("from the zanzibar transcript")]);
    const store = await open(fts);
    await store.sync();

    fs.renameSync(file, kept);
    forgetJournal();
    save("s1", [user("from the kalahari transcript")]);
    const recreated = fs.readFileSync(file);
    fs.unlinkSync(file);
    fs.renameSync(kept, file);
    const inode = fs.statSync(file).ino;
    fs.writeFileSync(file, recreated);
    expect(fs.statSync(file).ino).toBe(inode);

    expect((await store.search({ text: "zanzibar", limit: 5 })).hits).toEqual(
      [],
    );
    expect(
      (await store.search({ text: "kalahari", limit: 5 })).hits,
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

  it("matches a folder's sessions whichever host wrote them", async () => {
    // A folder with a space, and a link to it
    const repo = path.join(root, "my repo");
    const link = path.join(root, "link");
    fs.mkdirSync(repo);
    fs.symlinkSync(repo, link, "junction");
    save("cli", [user("shared word from cn")], repo);
    // VS Code records a percent-encoded file:// URI
    save(
      "vscode",
      [user("shared word from VS Code")],
      pathToFileURL(repo).href,
    );
    save("linked", [user("shared word through a link")], link);
    save("other", [user("shared word elsewhere")], path.join(root, "other"));
    const store = await open(fts);
    const asked = [repo, pathToFileURL(repo).href, link];
    if (process.platform === "darwin" || process.platform === "win32") {
      asked.push(repo.toUpperCase());
    }

    for (const workspace of asked) {
      const result = await store.search({
        text: "shared word",
        workspace,
        limit: 10,
      });
      expect(result.hits.map((h) => h.sessionId).sort()).toEqual([
        "cli",
        "linked",
        "vscode",
      ]);
    }
  });

  it("searches the folders of a multi-root window", async () => {
    save("a", [user("shared word in A")], "/repo-a");
    save("b", [user("shared word in B")], "/repo-b");
    save("c", [user("shared word in C")], "/repo-c");
    const store = await open(fts);

    const both = await store.search({
      text: "shared word",
      workspace: ["/repo-a", "file:///repo-b"],
      limit: 5,
    });
    const none = await store.search({
      text: "shared word",
      workspace: [],
      limit: 5,
    });

    expect(both.hits.map((h) => h.sessionId).sort()).toEqual(["a", "b"]);
    expect(none.hits).toEqual([]);
  });

  it("ranks a weak item with every word above stronger partial ones", async () => {
    const padding = "nothing relevant in this part. ".repeat(40);
    save("s1", [
      reply(`${padding} login ${padding} timeout ${padding} retry ${padding}`),
      // Long, so bm25 alone would rank the short one-word item above it
      read("auth.log", `${padding} login failed: timeout ${padding}`),
      user("retry retry retry"),
      // Enough other items for bm25 to tell common words from rare ones
      ...Array.from({ length: 12 }, (_, i) => user(`unrelated turn ${i}`)),
    ]);
    const store = await open(fts);

    const result = await store.search({
      text: "login timeout retry",
      limit: 5,
    });

    expect(result.hits.map((h) => [h.ord, h.missing])).toEqual([
      [0, undefined],
      [1, ["retry"]],
      [2, ["login", "timeout"]],
    ]);
  });

  it("answers a question asked in other words, skipping common ones", async () => {
    save("s1", [
      user("Login fails with a timeout after 30 seconds"),
      reply("Fixed it: raised the login timeout to 60s"),
      user("how did the tests go?"),
      user("We need to fix the build"),
    ]);
    const store = await open(fts);

    const result = await store.search({
      text: "how did we fix the login timeout",
      limit: 5,
    });

    expect(result.hits.map((h) => [h.ord, h.missing])).toEqual([
      [1, undefined],
      [0, ["fix"]],
      [3, ["login", "timeout"]],
    ]);
  });

  it("finds a word inside an identifier, but not the end of another word", async () => {
    save("s1", [
      user("call getElementById on the form"),
      reply("set userID and retry the XMLHttpRequest"),
      user("base64Encode the payload"),
      user("nothing to note here"),
      reply("fix the parser"),
    ]);
    const store = await open(fts);
    const ords = async (text: string) =>
      (await store.search({ text, limit: 5 })).hits
        .filter((h) => !h.missing)
        .map((h) => h.ord);

    expect(await ords("byId")).toEqual([0]);
    expect((await ords("id")).sort()).toEqual([0, 1]);
    expect(await ords("http")).toEqual([1]);
    expect(await ords("encode")).toEqual([2]);
    // A word must end where the query's does, give or take an ending
    expect(await ords("not")).toEqual([]);
    // Another form of the word, found through the text its forms share
    expect(await ords("fixing")).toEqual([4]);
  });

  it("marks in the snippet the word that counted, not one it only resembles", async () => {
    save("s1", [user(`prefix ${"padding ".repeat(30)}then the fix landed`)]);
    const store = await open(fts);

    const [hit] = (await store.search({ text: "fix", limit: 5 })).hits;

    expect(hit.snippet).toContain("then the «fix» landed");
    expect(hit.snippet).not.toMatch(/pre«?fix/);
  });

  it("matches a word only where one starts, not inside another word", async () => {
    save("s1", [
      user("prefix the login timeout in the config"),
      reply("Fixed the login timeout"),
      user("another login timeout"),
      user("loadConfig failed with a timeout"),
    ]);
    const store = await open(fts);

    const fix = await store.search({
      text: "how did we fix the login timeout",
      limit: 5,
    });
    const not = await store.search({ text: "not timeout", limit: 5 });
    const config = await store.search({ text: "config", limit: 5 });
    const fixAlone = await store.search({ text: "fix", limit: 5 });

    // "Fixed" starts with fix; "prefix" only contains it
    expect(fix.hits[0]).toMatchObject({ ord: 1 });
    expect(fix.hits[0].missing).toBeUndefined();
    expect(fix.hits.find((h) => h.ord === 0)?.missing).toEqual(["fix"]);
    // "another" contains not, but no word starts with it
    expect(not.hits.every((h) => h.missing?.includes("not"))).toBe(true);
    // An item where the word is only inside other words is no hit at all
    expect(fixAlone.hits.map((h) => h.ord)).toEqual([1]);
    // A camelCase hump starts a word
    expect(config.hits.map((h) => h.ord).sort()).toEqual([0, 3]);
  });

  it("searches every real word of a long question", async () => {
    save("s1", [user("the retry budget was raised")]);
    const store = await open(fts);

    // Stop words first: they must not use up the cap on words
    const result = await store.search({
      text: "the a an and are as at be been but by can could did do does retry budget migration",
      limit: 5,
    });

    expect(result.hits.map((h) => [h.ord, h.missing])).toEqual([
      [0, ["migration"]],
    ]);
  });

  it("puts a snippet on one line", async () => {
    save("s1", [user("please refactor\n\nthe importer")]);
    const store = await open(fts);

    const [hit] = (await store.search({ text: "refactor", limit: 5 })).hits;

    expect(hit.snippet).toContain("refactor");
    expect(hit.snippet).not.toMatch(/\n/);
  });

  it("finds only items with every word of a query of common words", async () => {
    save("s1", [user("how did we do that again?"), user("how did it go")]);
    const store = await open(fts);

    const result = await store.search({ text: "how did we do that", limit: 5 });

    expect(result.hits.map((h) => [h.ord, h.missing])).toEqual([
      [0, undefined],
    ]);
  });

  it("keeps partial hits to the scope searched, without undone turns", async () => {
    save("s1", [user("the login screen"), reply("noted")]);
    save("s1", [user("the login screen"), reply("noted"), user("login again")]);
    save("s1", [user("the login screen"), reply("noted")]);
    save("s2", [user("login retry from another session")]);
    const store = await open(fts);

    const result = await store.search({
      text: "login retry",
      sessionIds: ["s1"],
      limit: 5,
    });

    expect(result.hits.map((h) => [h.sessionId, h.ord, h.missing])).toEqual([
      ["s1", 0, ["retry"]],
    ]);
  });

  it("shows a forked partial hit once, from the newest copy", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000);
      save("s1", [user("the login screen froze")]);
      vi.setSystemTime(2_000);
      save("s2", [user("the login screen froze")]);
    } finally {
      vi.useRealTimers();
    }
    const store = await open(fts);

    const result = await store.search({ text: "login retry", limit: 5 });

    expect(result.hits.map((h) => [h.sessionId, h.missing])).toEqual([
      ["s2", ["retry"]],
    ]);
  });

  it("shows the words an item has in its snippet", async () => {
    save("s1", [user(`${"padding ".repeat(80)}the request hit a timeout`)]);
    const store = await open(fts);

    const result = await store.search({ text: "zebra timeout", limit: 5 });

    expect(result.hits[0].missing).toEqual(["zebra"]);
    expect(result.hits[0].snippet).toContain("timeout");
  });

  it("needs a short term for a full hit, but doesn't rank by it", async () => {
    save("s1", [
      user("exit code 42 from the build"),
      reply("the build passed"),
      reply("error 42 in the parser"),
    ]);
    const store = await open(fts);

    const result = await store.search({ text: "42 build", limit: 5 });

    // Under 3 characters, 42 matches as a substring: it decides a full hit
    // and is listed as missing, but alone it makes nothing a partial hit
    expect(result.hits.map((h) => [h.ord, h.missing])).toEqual([
      [0, undefined],
      [1, ["42"]],
    ]);
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
      // Its rows are still indexed, its file is gone
      expect(await store.read("s1", 0, 10)).toEqual({
        items: [],
        pending: true,
      });
    } finally {
      await other.exec("ROLLBACK");
      await other.close();
    }
    expect(await store.sync()).toBe(0);
  });

  // SQLite takes an empty IN (), unlike most databases
  it("finds nothing in an empty list of sessions", async () => {
    save("s1", [user("a turn in some session")]);
    const store = await open(fts);

    const result = await store.search({
      text: "turn",
      sessionIds: [],
      limit: 5,
    });

    expect(result.hits).toEqual([]);
  });

  it("skips a transcript deleted while the sync runs", async () => {
    save("s1", [user("the first session")]);
    save("s2", [user("the second session")]);
    // Whichever session is indexed first deletes the other's transcript,
    // after the folder was listed
    let deleted = false;
    const store = await HistoryStore.open({
      dbPath,
      sessionsDir,
      fts,
      redact: (text) => {
        if (!deleted) {
          deleted = true;
          const other = text.includes("first") ? "s2" : "s1";
          fs.unlinkSync(path.join(sessionsDir, `${other}.jsonl`));
        }
        return text;
      },
    });
    stores.push(store);

    const result = await store.search({ text: "session", limit: 5 });

    expect(deleted).toBe(true);
    expect(result.hits).toHaveLength(1);
  });

  it("reads the turns after a line a crash cut inside a character", async () => {
    const file = path.join(sessionsDir, "s1.jsonl");
    save("s1", [user("before the crash")]);
    // The write stopped after the first byte of "é" (2 bytes in UTF-8)
    fs.appendFileSync(
      file,
      Buffer.concat([
        Buffer.from(
          '{"t":"put","i":1,"h":"x","ts":1,"item":{"role":"user","content":"caf',
        ),
        Buffer.from("é").subarray(0, 1),
      ]),
    );
    forgetJournal();
    save("s1", [user("before the crash"), reply("after the crash")]);
    const store = await open(fts);

    const result = await store.read("s1", 0, 10);
    const again = await store.read("s1", 0, 10);

    expect(result.items.map((i) => i.text)).toEqual([
      "user: before the crash",
      "assistant: after the crash",
    ]);
    expect(result.pending).toBe(false);
    expect(again.items.map((i) => i.ord)).toEqual(
      result.items.map((i) => i.ord),
    );
  });

  it("says where to read on when the size limit stops a read", async () => {
    save("s1", [
      read("a.log", "a".repeat(30_000)),
      read("b.log", "b".repeat(30_000)),
      read("c.log", "c".repeat(30_000)),
    ]);
    save(
      "s2",
      Array.from({ length: 45 }, (_, i) => user(`turn ${i}`)),
    );
    const store = await open(fts);

    const bySize = await store.read("s1", 0, 2);
    const byCount = await store.read("s2", 0, 44);
    const whole = await store.read("s2", 40, 44);

    expect(bySize.items.map((i) => i.ord)).toEqual([0, 1]);
    expect(bySize.next).toBe(2);
    expect(byCount.items).toHaveLength(40);
    expect(byCount.next).toBe(40);
    expect(whole.items).toHaveLength(5);
    expect(whole.next).toBeUndefined();
  });

  it("leaves undone turns out of a read, as out of a search", async () => {
    save("s1", [user("first"), reply("kept"), user("the undone ask")]);
    save("s1", [user("first"), reply("kept")]);
    const store = await open(fts);

    const { items } = await store.read("s1", 0, 10);

    expect(items.map((i) => i.text)).toEqual([
      "user: first",
      "assistant: kept",
    ]);
  });

  it("outlines a session cn compacted: its user turns and the summary", async () => {
    save("s1", [
      user("Fix the config loader"),
      read("src/config.ts", "the file"),
      reply("Fixed it"),
      user("Now the tests"),
    ]);
    save("s1", [summary("Summary: fixed the loader"), user("Continue")]);
    save("s1", [
      summary("Summary: fixed the loader"),
      user("Continue"),
      user("an undone ask"),
    ]);
    save("s1", [summary("Summary: fixed the loader"), user("Continue")]);
    const store = await open(fts);

    const outline = await store.outline("s1");

    expect(outline.items.map((i) => [i.ord, i.kind, i.state, i.text])).toEqual([
      [0, "user", "folded", "Fix the config loader"],
      [3, "user", "folded", "Now the tests"],
      [4, "summary", "live", "Summary: fixed the loader"],
      [5, "user", "live", "Continue"],
    ]);
    expect(outline.pending).toBe(false);
    expect(outline.next).toBeUndefined();
  });

  it("outlines a summary VS Code sets on a message, until it is removed", async () => {
    const turns = [user("Refactor the importer"), reply("Done refactoring")];
    save("s1", turns);
    save("s1", [
      turns[0],
      { ...turns[1], conversationSummary: "Summary: the importer was split" },
    ]);
    const store = await open(fts);

    const summarized = await store.outline("s1");
    save("s1", turns);
    const removed = await store.outline("s1");

    expect(summarized.items.map((i) => [i.ord, i.kind, i.text])).toEqual([
      [0, "user", "Refactor the importer"],
      [1, "summary", "Summary: the importer was split"],
    ]);
    expect(removed.items.map((i) => [i.ord, i.kind])).toEqual([[0, "user"]]);
  });

  it("lists a summarized user message once, as its summary", async () => {
    const turns = [
      user("Refactor the importer"),
      reply("Done"),
      user("Now the exporter"),
    ];
    save("s1", turns);
    save("s1", [
      turns[0],
      turns[1],
      { ...turns[2], conversationSummary: "Summary: importer done" },
    ]);
    const store = await open(fts);

    const outline = await store.outline("s1");

    expect(outline.items.map((i) => [i.ord, i.kind, i.text])).toEqual([
      [0, "user", "Refactor the importer"],
      [2, "summary", "Summary: importer done"],
    ]);
  });

  it("puts each outline item on one short line", async () => {
    save("s1", [user(`first   line\n\nsecond line ${"word ".repeat(60)}`)]);
    const store = await open(fts);

    const [item] = (await store.outline("s1")).items;

    expect(item.text).toMatch(/^first line second line word word/);
    expect(item.text).not.toContain("\n");
    expect(Array.from(item.text)).toHaveLength(161);
    expect(item.text.endsWith("…")).toBe(true);
  });

  it("pages a long outline", async () => {
    save(
      "s1",
      Array.from({ length: 105 }, (_, i) => user(`turn ${i}`)),
    );
    const store = await open(fts);

    const first = await store.outline("s1");
    const rest = await store.outline("s1", first.next);

    expect(first.items).toHaveLength(100);
    expect(first.next).toBe(100);
    expect(rest.items.map((i) => i.ord)).toEqual([100, 101, 102, 103, 104]);
    expect(rest.next).toBeUndefined();
  });

  it("says an outline is pending when the index is busy", async () => {
    save("s1", [user("a turn not indexed yet")]);
    const store = await open(fts);
    const other = await SqliteDatabase.open(indexFile(fts));
    await other.exec("BEGIN IMMEDIATE");
    try {
      expect(await store.outline("s1")).toEqual({ items: [], pending: true });
    } finally {
      await other.exec("ROLLBACK");
      await other.close();
    }
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
        const { hits } = await store.search({ text, limit: 5 });
        expect(hits.filter((h) => !h.missing)).toHaveLength(1);
      }
    }
  });
});

describe("HistoryStore and an index of another layout", () => {
  it("rebuilds an index made before summaries were flagged", async () => {
    const fts = sqliteHasFts5();
    save("s1", [summary("Summary: the work so far"), user("Continue")]);
    const first = await open(fts);
    await first.sync();
    await first.close();
    stores.splice(stores.indexOf(first), 1);
    // The previous layout: no summary column
    const old = await SqliteDatabase.open(indexFile(fts));
    await old.exec(`
      ALTER TABLE messages DROP COLUMN summary;
      PRAGMA user_version = 1;
    `);
    await old.close();

    const store = await open(fts);
    const outline = await store.outline("s1");

    expect(outline.items.map((i) => [i.ord, i.kind])).toEqual([
      [0, "summary"],
      [1, "user"],
    ]);
  });

  it("leaves an index of a newer layout alone, and says why", async () => {
    const fts = sqliteHasFts5();
    save("s1", [user("indexed by a newer version")]);
    const first = await open(fts);
    await first.sync();
    await first.close();
    stores.splice(stores.indexOf(first), 1);
    const newer = await SqliteDatabase.open(indexFile(fts));
    await newer.exec("PRAGMA user_version = 99");
    await newer.close();

    await expect(open(fts)).rejects.toThrow(/newer version of NextCLI/);

    const db = await SqliteDatabase.open(indexFile(fts));
    try {
      expect(await db.get("PRAGMA user_version")).toEqual({ user_version: 99 });
      expect(
        await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages"),
      ).toEqual({ n: 1 });
    } finally {
      await db.close();
    }
  });
});

describe("HistoryStore and an index of an older layout", () => {
  it("builds it again from the transcripts", async () => {
    const fts = sqliteHasFts5();
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    save(
      "s1",
      [user("indexed again after an upgrade")],
      pathToFileURL(repo).href,
    );
    const first = await open(fts);
    await first.sync();
    await first.close();
    stores.splice(stores.indexOf(first), 1);
    // As the previous layout stored it: the workspace as the host wrote it
    const old = await SqliteDatabase.open(indexFile(fts));
    await old.exec(`
      UPDATE journals SET workspace = '${pathToFileURL(repo).href}';
      PRAGMA user_version = 0;
    `);
    await old.close();

    const store = await open(fts);
    const result = await store.search({
      text: "upgrade",
      workspace: repo,
      limit: 5,
    });

    expect(result.hits.map((h) => h.sessionId)).toEqual(["s1"]);
  });
});
