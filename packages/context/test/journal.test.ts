import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forgetJournal, syncJournal } from "../src/archive/index.js";
import {
  hashing,
  itemHash,
  JournalLine,
  JournalReplay,
  JournalSourceItem,
} from "../src/archive/journal.js";

let dir: string;
let journal: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-"));
  journal = path.join(dir, "s1.jsonl");
  forgetJournal();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const user = (content: string): JournalSourceItem => ({
  message: { role: "user", content },
  contextItems: [],
});
const reply = (content: string): JournalSourceItem => ({
  message: { role: "assistant", content },
  contextItems: [],
});
const summary = (text: string): JournalSourceItem => ({
  message: { role: "assistant", content: text },
  contextItems: [],
  conversationSummary: text,
});
const toolStep = (
  ...calls: [name: string, status: string, output?: string][]
): JournalSourceItem => ({
  message: { role: "assistant", content: "" },
  contextItems: [],
  toolCallStates: calls.map(([name, status, output], i) => ({
    toolCallId: `call-${name}-${i}`,
    status,
    toolCall: { function: { name, arguments: "{}" } },
    output: output ? [{ content: output }] : undefined,
  })),
});
// VS Code also keeps each result as a tool message after the step
const toolMessage = (id: string, content: string): JournalSourceItem => ({
  message: { role: "tool", content, toolCallId: id },
  contextItems: [],
});

// Skips a torn line, as the journal's own reader does
function lines(): JournalLine[] {
  return fs
    .readFileSync(journal, "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        return l ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
}

function replayed(): JournalReplay {
  const replay = new JournalReplay();
  for (const line of lines()) {
    replay.apply(line);
  }
  return replay;
}

const putContents = () =>
  lines()
    .filter((l) => l.t === "put")
    .map((l) => (l.t === "put" ? l.item.content : ""));

describe("syncJournal", () => {
  it("keeps every turn when cn's compaction replaces them with a summary", () => {
    const turns = [
      user("Fix src/auth.ts"),
      reply("ENOENT in loadConfig"),
      user("keep the API"),
      reply("done"),
    ];
    syncJournal(journal, turns);
    syncJournal(journal, [summary("Summary of four turns"), user("Continue")]);

    const kinds = lines().map((l) => l.t);
    expect(kinds).toEqual([
      "head",
      "put",
      "put",
      "put",
      "put",
      "fold",
      "put",
      "put",
    ]);
    expect(lines()[5]).toMatchObject({ t: "fold", from: 0, n: 4 });
    expect(putContents()).toContain("ENOENT in loadConfig");
    expect(replayed().live).toHaveLength(2);
  });

  it("records an undo as a cut and a redo as the same items again", () => {
    const turns = [user("a"), reply("b"), user("c"), reply("d")];
    syncJournal(journal, turns);
    syncJournal(journal, turns.slice(0, 2));
    syncJournal(journal, turns);

    const tail = lines().slice(5);
    expect(tail.map((l) => l.t)).toEqual(["cut", "put", "put"]);
    expect(tail[0]).toMatchObject({ n: 2 });
    expect(replayed().live).toHaveLength(4);
  });

  it("writes a step once when VS Code saves while its sibling calls still run", () => {
    const ask = user("read both");
    // After call A finishes: its tool message is saved, B still runs
    syncJournal(journal, [
      ask,
      toolStep(["Read", "done", "A's file"], ["Read", "calling"]),
      toolMessage("call-Read-0", "A's file"),
    ]);
    syncJournal(journal, [
      ask,
      toolStep(["Read", "done", "A's file"], ["Read", "done", "B's file"]),
      toolMessage("call-Read-0", "A's file"),
      toolMessage("call-Read-1", "B's file"),
    ]);

    const puts = lines().filter((l) => l.t === "put");
    expect(puts).toHaveLength(4);
    expect(lines().some((l) => l.t === "cut")).toBe(false);
  });

  it("records a summary VS Code sets or removes as one line, with no cut", () => {
    // VS Code sends fresh objects with every save
    const turns = () => [user("a"), reply("b"), user("c"), reply("d")];
    syncJournal(journal, turns());
    syncJournal(journal, [
      ...turns().slice(0, 3),
      { ...reply("d"), conversationSummary: "Summary up to d" },
    ]);
    syncJournal(journal, turns());

    expect(lines().slice(5)).toMatchObject([
      { t: "summary", i: 3, text: "Summary up to d" },
      { t: "summary", i: 3, text: null },
    ]);
  });

  it("treats a delete before a summarized message as a cut, not a fold", () => {
    const summarized = { ...reply("d"), conversationSummary: "Summary" };
    syncJournal(journal, [user("a"), reply("b"), summarized]);
    syncJournal(journal, [user("a"), summarized]);

    expect(lines().some((l) => l.t === "fold")).toBe(false);
    expect(replayed().live).toHaveLength(2);
  });

  it("journals a session's earlier turns first when its first save compacts", () => {
    const sessionFile = path.join(dir, "s1.json");
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        history: [user("REQUIREMENT: keep the API"), reply("read 30 files")],
      }),
    );

    syncJournal(journal, [summary("Summary"), user("Continue")], {
      sessionFile,
    });

    expect(putContents()).toEqual([
      "REQUIREMENT: keep the API",
      "read 30 files",
      "Summary",
      "Continue",
    ]);
    expect(lines()[3]).toMatchObject({ t: "fold", from: 0, n: 2 });
  });

  it("catches up with another writer's lines before writing its own", () => {
    syncJournal(journal, [user("a")]);
    // Another process (cn and VS Code on one session) journaled the reply
    fs.appendFileSync(
      journal,
      JSON.stringify({
        t: "put",
        i: 1,
        h: itemHash(reply("b")),
        ts: 1,
        item: { role: "assistant", content: "b" },
      }) + "\n",
    );

    syncJournal(journal, [user("a"), reply("b"), user("c")]);

    expect(putContents()).toEqual(["a", "b", "c"]);
  });

  it("replaces another writer's diverging item from its position", () => {
    syncJournal(journal, [user("a")]);
    fs.appendFileSync(
      journal,
      JSON.stringify({
        t: "put",
        i: 1,
        h: "other",
        ts: 1,
        item: { role: "assistant", content: "from the other writer" },
      }) + "\n",
    );

    syncJournal(journal, [user("a"), reply("b")]);

    // Kept in the file, and replaced in the live view: last writer wins, as
    // the session file does
    expect(putContents()).toEqual(["a", "from the other writer", "b"]);
    expect(replayed().live).toHaveLength(2);
  });

  it("starts on a new line after a line torn by a crash", () => {
    syncJournal(journal, [user("a")]);
    fs.appendFileSync(journal, '{"t":"put","i":1,"h":"x","ts":1,"item":{"ro');
    forgetJournal(journal);

    syncJournal(journal, [user("a"), reply("b")]);

    expect(putContents()).toEqual(["a", "b"]);
    expect(replayed().live).toHaveLength(2);
  });

  it("stores what the model saw, not prompts, editor state or message ids", () => {
    syncJournal(journal, [
      {
        message: { role: "user", content: "hi", id: "m1" } as never,
        contextItems: [],
        editorState: { doc: "EDITOR_STATE" },
        promptLogs: [{ prompt: "THE_WHOLE_PROMPT" }],
      } as JournalSourceItem,
    ]);

    const text = fs.readFileSync(journal, "utf8");
    expect(text).not.toContain("EDITOR_STATE");
    expect(text).not.toContain("THE_WHOLE_PROMPT");
    expect(text).not.toContain('"m1"');
  });

  it("writes nothing when VS Code saves a session cn wrote", () => {
    syncJournal(journal, [user("a"), reply("b")]);
    const before = fs.readFileSync(journal, "utf8");
    forgetJournal(journal);

    // VS Code reads it back: fresh objects, an id, content as text parts
    syncJournal(journal, [
      {
        message: {
          role: "user",
          content: [{ type: "text", text: "a" }],
          id: "x",
        } as never,
        contextItems: [],
      },
      reply("b"),
    ]);

    expect(fs.readFileSync(journal, "utf8")).toBe(before);
  });

  it("hashes nothing again when cn saves an unchanged history", () => {
    const turns = [user("a"), reply("b"), toolStep(["Bash", "calling"])];
    syncJournal(journal, turns);
    const hashed = hashing.count;
    const size = fs.statSync(journal).size;

    // A Bash output chunk: the running step changes, nothing settled does
    syncJournal(journal, [...turns.slice(0, 2), toolStep(["Bash", "calling"])]);
    syncJournal(journal, turns);

    expect(hashing.count - hashed).toBe(0);
    expect(fs.statSync(journal).size).toBe(size);
  });
});
