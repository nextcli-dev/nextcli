import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  forgetJournal,
  syncJournal,
  type JournalSourceItem,
} from "../src/archive/index.js";
import { HistoryStore } from "../src/historyStore/index.js";
import { sqliteHasFts5 } from "../src/sqlite.js";

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

    const items = await a.read("s1", 0, 100);
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

  it("shows an item a forked session copied once", async () => {
    const history = [user("the forked requirement"), reply("ok")];
    save("s1", history);
    save("s2", history);
    const store = await open(fts);

    const result = await store.search({ text: "forked requirement", limit: 5 });

    expect(result.hits).toHaveLength(1);
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

    const items = await store.read("s1", 0, 10);

    expect(items.map((i) => [i.ord, i.state])).toEqual([
      [0, "folded"],
      [1, "folded"],
      [2, "live"],
      [3, "live"],
    ]);
    expect(items[0].text).toBe("user: key [redacted]");
  });
});
