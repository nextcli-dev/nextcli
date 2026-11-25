import fs from "fs";
import path from "path";

import { v4 as uuidv4 } from "uuid";
import { describe, expect, it, vi } from "vitest";

import { Session } from "..";
import historyManager from "./history";
import { getSessionFilePath } from "./paths";

const PROMPT_TEXT = "the whole rendered conversation sent to the model";

// A session as earlier versions wrote it: every model call kept its prompt
function writeSessionWithPrompts(sessionId: string) {
  const session = {
    sessionId,
    title: "Saved by an earlier version",
    workspaceDirectory: "/workspace",
    history: [
      {
        message: { id: "u1", role: "user", content: "Fix the bug" },
        contextItems: [],
      },
      {
        message: { id: "a1", role: "assistant", content: "Reading the file" },
        contextItems: [],
        toolCallStates: [
          {
            toolCallId: "t1",
            status: "done",
            parsedArgs: { prompt: "a tool argument named prompt" },
          },
        ],
        promptLogs: [
          {
            modelTitle: "Model",
            modelProvider: "openai",
            prompt: `${PROMPT_TEXT} 1`,
            completion: "Reading the file",
            finishReason: "tool_calls",
            usage: { promptTokens: 100, completionTokens: 5 },
            costUsd: 0.01,
            priced: "exact",
          },
          {
            modelTitle: "Model",
            modelProvider: "openai",
            prompt: `${PROMPT_TEXT} 2`,
            completion: "Done",
            finishReason: "stop",
          },
        ],
      },
    ],
  };
  fs.writeFileSync(
    getSessionFilePath(sessionId),
    JSON.stringify(session, undefined, 2),
  );
  return session;
}

describe("HistoryManager and model-call prompts", () => {
  it("load returns the prompt logs without their prompts, every other field kept", () => {
    const sessionId = uuidv4();
    const written = writeSessionWithPrompts(sessionId);

    const loaded = historyManager.load(sessionId);

    const logs = loaded.history[1].promptLogs!;
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(log).not.toHaveProperty("prompt");
    }
    const { prompt, ...firstWithoutPrompt } = written.history[1].promptLogs![0];
    expect(logs[0]).toEqual(firstWithoutPrompt);
    expect(JSON.stringify(loaded)).not.toContain(PROMPT_TEXT);
  });

  it("load keeps fields named prompt outside the prompt logs", () => {
    const sessionId = uuidv4();
    writeSessionWithPrompts(sessionId);

    const loaded = historyManager.load(sessionId);

    expect(loaded.history[1].toolCallStates?.[0].parsedArgs).toEqual({
      prompt: "a tool argument named prompt",
    });
    expect(loaded.history[0].message.content).toBe("Fix the bug");
  });

  it("load leaves the file as it is", () => {
    const sessionId = uuidv4();
    writeSessionWithPrompts(sessionId);
    const before = fs.readFileSync(getSessionFilePath(sessionId), "utf8");

    historyManager.load(sessionId);

    expect(fs.readFileSync(getSessionFilePath(sessionId), "utf8")).toBe(before);
  });

  it("the next save writes the session without the prompts", () => {
    const sessionId = uuidv4();
    writeSessionWithPrompts(sessionId);
    const loaded = historyManager.load(sessionId);

    historyManager.save(loaded);

    const file = fs.readFileSync(getSessionFilePath(sessionId), "utf8");
    expect(file).not.toContain(PROMPT_TEXT);
    expect(historyManager.load(sessionId)).toEqual(loaded);
  });

  // cn --resume and /import parse a session file themselves, prompts included
  it("save writes no prompt that is still on the session", () => {
    const sessionId = uuidv4();
    writeSessionWithPrompts(sessionId);
    const session: Session = JSON.parse(
      fs.readFileSync(getSessionFilePath(sessionId), "utf8"),
    );

    historyManager.save(session);

    const file = fs.readFileSync(getSessionFilePath(sessionId), "utf8");
    expect(file).not.toContain(PROMPT_TEXT);
    expect(file).toContain("Reading the file");
  });

  // An empty session under the same id would replace the file on its next save
  describe("a session file that isn't the expected shape still loads", () => {
    const writeRaw = (sessionId: string, session: object) =>
      fs.writeFileSync(getSessionFilePath(sessionId), JSON.stringify(session));

    it("keeps entries that aren't objects", () => {
      const sessionId = uuidv4();
      writeRaw(sessionId, {
        sessionId,
        title: "Odd entries",
        workspaceDirectory: "/workspace",
        history: [
          null,
          {
            message: { role: "assistant", content: "Done" },
            contextItems: [],
            promptLogs: [null, { prompt: PROMPT_TEXT, completion: "Done" }],
          },
        ],
      });

      const loaded = historyManager.load(sessionId);

      expect(loaded.title).toBe("Odd entries");
      expect(loaded.history[0]).toBeNull();
      expect(loaded.history[1].promptLogs).toEqual([
        null,
        { completion: "Done" },
      ]);
    });

    it("keeps a session saved without a history", () => {
      const sessionId = uuidv4();
      writeRaw(sessionId, {
        sessionId,
        title: "No history",
        workspaceDirectory: "/workspace",
      });

      const loaded = historyManager.load(sessionId);

      expect(loaded.title).toBe("No history");
      expect(loaded.history).toEqual([]);
    });
  });
});

describe("HistoryManager and the session transcript", () => {
  const item = (role: "user" | "assistant", content: string) => ({
    message: { role, content },
    contextItems: [],
  });
  const session = (sessionId: string, history: Session["history"]): Session =>
    ({
      sessionId,
      title: "Transcript",
      workspaceDirectory: "/workspace",
      history,
    }) as Session;
  const transcript = (sessionId: string) =>
    fs.readFileSync(getSessionFilePath(sessionId) + "l", "utf8");

  it("keeps the turns a compaction replaced, while the session file drops them", () => {
    const sessionId = uuidv4();
    historyManager.save(
      session(sessionId, [
        item("user", "REQUIREMENT: keep the public API"),
        item("assistant", "ENOENT in loadConfig, fixed"),
      ] as Session["history"]),
    );
    historyManager.save(
      session(sessionId, [
        { ...item("assistant", "Summary"), conversationSummary: "Summary" },
        item("user", "Continue"),
      ] as Session["history"]),
    );

    expect(
      fs.readFileSync(getSessionFilePath(sessionId), "utf8"),
    ).not.toContain("ENOENT");
    expect(transcript(sessionId)).toContain("REQUIREMENT: keep the public API");
    expect(transcript(sessionId)).toContain("ENOENT in loadConfig, fixed");
    expect(transcript(sessionId)).toContain('"t":"fold"');
  });

  it("journals a session saved before transcripts existed before compacting it", () => {
    const sessionId = uuidv4();
    fs.writeFileSync(
      getSessionFilePath(sessionId),
      JSON.stringify(
        session(sessionId, [
          item("user", "an early requirement"),
        ] as Session["history"]),
      ),
    );

    historyManager.save(
      session(sessionId, [
        { ...item("assistant", "Summary"), conversationSummary: "Summary" },
      ] as Session["history"]),
    );

    expect(transcript(sessionId)).toContain("an early requirement");
  });

  // A read-only file stands in for a full disk; root and Windows ignore it
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "writes the turns a failed transcript write missed on the next save",
    () => {
      const sessionId = uuidv4();
      const journal = getSessionFilePath(sessionId) + "l";
      const turns = [
        item("user", "hi"),
        item("assistant", "the turn the failed write missed"),
      ] as Session["history"];
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        historyManager.save(session(sessionId, turns.slice(0, 1)));
        fs.chmodSync(journal, 0o444);

        historyManager.save(session(sessionId, turns));
        historyManager.save(session(sessionId, turns));
        // The session itself is saved, and the failure reported once
        expect(
          fs.readFileSync(getSessionFilePath(sessionId), "utf8"),
        ).toContain("the turn the failed write missed");
        expect(warn).toHaveBeenCalledTimes(1);

        fs.chmodSync(journal, 0o644);
        historyManager.save(session(sessionId, turns));
        expect(transcript(sessionId)).toContain(
          "the turn the failed write missed",
        );

        // A later failure is reported again
        fs.chmodSync(journal, 0o444);
        historyManager.save(
          session(sessionId, [...turns, item("user", "more")]),
        );
        expect(warn).toHaveBeenCalledTimes(2);
      } finally {
        fs.chmodSync(journal, 0o644);
        warn.mockRestore();
      }
    },
  );

  it("deletes the transcript with the session, even when its file is gone", () => {
    const sessionId = uuidv4();
    historyManager.save(
      session(sessionId, [item("user", "hi")] as Session["history"]),
    );
    fs.unlinkSync(getSessionFilePath(sessionId));

    expect(() => historyManager.delete(sessionId)).toThrow();
    expect(fs.existsSync(getSessionFilePath(sessionId) + "l")).toBe(false);
  });

  it("writes no transcript for an id that isn't a file name", () => {
    const outside = path.join(
      path.dirname(getSessionFilePath("x")),
      "..",
      "escaped",
    );

    // /import takes the id from a file
    historyManager.save(
      session("../escaped", [item("user", "hi")] as Session["history"]),
    );

    expect(fs.existsSync(`${outside}.jsonl`)).toBe(false);
    fs.rmSync(`${outside}.json`, { force: true });
  });
});
