import fs from "fs";

import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";

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
});
