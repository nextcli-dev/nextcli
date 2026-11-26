import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetJournal, syncJournal } from "../src/archive/index.js";
import {
  itemHash,
  JournalLine,
  JournalReplay,
  JournalSourceItem,
} from "../src/archive/journal.js";

// Counts hashing, to check unchanged items aren't hashed again
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, createHash: vi.fn(crypto.createHash) };
});
const hashes = () => vi.mocked(createHash).mock.calls.length;

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

  it("doesn't take an edit of a summarized message for a compaction", () => {
    const turns = (text: string) => [
      user("a"),
      { ...reply(text), conversationSummary: "Summary" },
      user("c"),
      reply("d"),
    ];
    syncJournal(journal, turns("b"));
    syncJournal(journal, turns("b, edited"));

    expect(lines().some((l) => l.t === "fold")).toBe(false);
    expect(replayed().live).toEqual(turns("b, edited").map(itemHash));
  });

  it("folds for a new summary even when its message matches an earlier turn", () => {
    syncJournal(journal, [reply("x"), user("c"), reply("d")]);
    syncJournal(journal, [
      reply("x"),
      { ...reply("x"), conversationSummary: "Summary of c and d" },
    ]);

    expect(lines().find((l) => l.t === "fold")).toMatchObject({
      from: 1,
      n: 3,
    });
  });

  it("records a replaced image, without keeping the image", () => {
    const shot = (url: string): JournalSourceItem => ({
      message: {
        role: "user",
        content: [
          { type: "text", text: "see " },
          { type: "imageUrl", imageUrl: { url } },
        ],
      },
      contextItems: [],
    });
    syncJournal(journal, [shot("data:image/png;base64,FIRSTPICTURE")]);
    syncJournal(journal, [shot("data:image/png;base64,SECONDPICTURE")]);

    expect(putContents()).toEqual(["see [image]", "see [image]"]);
    expect(fs.readFileSync(journal, "utf8")).not.toContain("PICTURE");
  });

  // A read-only file stands in for a full disk; root and Windows ignore it
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "writes on the next save what a failed append missed",
    () => {
      syncJournal(journal, [user("a")]);
      fs.chmodSync(journal, 0o444);
      expect(() => syncJournal(journal, [user("a"), reply("b")])).toThrow();
      fs.chmodSync(journal, 0o644);

      syncJournal(journal, [user("a"), reply("b")]);

      expect(putContents()).toEqual(["a", "b"]);
    },
  );

  it("catches up with another writer when its own history is unchanged", () => {
    const turns = [user("a"), reply("b"), user("c"), reply("d")];
    syncJournal(journal, turns);
    // The other process undid the last turn
    fs.appendFileSync(
      journal,
      JSON.stringify({ t: "cut", n: 2, ts: 1 }) + "\n",
    );

    // This process saves its history, and writes it to the session file
    syncJournal(journal, turns);

    expect(replayed().live).toEqual(turns.map(itemHash));
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
    const hashed = hashes();
    const size = fs.statSync(journal).size;

    // A Bash output chunk: the running step changes, nothing settled does
    syncJournal(journal, [...turns.slice(0, 2), toolStep(["Bash", "calling"])]);
    syncJournal(journal, turns);

    expect(hashes() - hashed).toBe(0);
    expect(fs.statSync(journal).size).toBe(size);
  });
});
