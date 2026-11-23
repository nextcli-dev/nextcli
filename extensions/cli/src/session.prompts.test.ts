import fs from "fs";
import path from "path";

import { describe, expect, it } from "vitest";

import { loadSession, saveSession } from "./session.js";

// vitest.global-dir-setup.ts gives each test file its own CONTINUE_GLOBAL_DIR,
// which both cn and core's HistoryManager use for sessions
const sessionsDir = () =>
  path.join(process.env.CONTINUE_GLOBAL_DIR!, "sessions");

const PROMPT_TEXT = "the whole rendered conversation sent to the model";

function writeSession(sessionId: string, withPrompt: boolean) {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  const file = path.join(sessionsDir(), `${sessionId}.json`);
  const log = {
    modelTitle: "Model",
    modelProvider: "openai",
    completion: "Done",
    usage: { promptTokens: 100, completionTokens: 5 },
    ...(withPrompt && { prompt: PROMPT_TEXT }),
  };
  fs.writeFileSync(
    file,
    JSON.stringify({
      sessionId,
      title: "Saved in VS Code",
      workspaceDirectory: "/workspace",
      history: [
        { message: { role: "user", content: "Fix the bug" }, contextItems: [] },
        {
          message: { role: "assistant", content: "Done" },
          contextItems: [],
          promptLogs: [log],
        },
      ],
    }),
  );
  // --resume opens the most recently modified session
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(file, future, future);
  return file;
}

describe("cn --resume and saved prompts", () => {
  it("saving a resumed session written with prompts drops them", () => {
    const file = writeSession("4f9a2c1e-7b3d-4e8a-9c2f-1a5b6c7d8e01", true);

    loadSession();
    saveSession();

    const saved = fs.readFileSync(file, "utf8");
    expect(saved).not.toContain(PROMPT_TEXT);
    expect(JSON.parse(saved).history[1].promptLogs[0]).toMatchObject({
      completion: "Done",
      usage: { promptTokens: 100, completionTokens: 5 },
    });
  });

  it("a VS Code session without prompts round-trips through resume", () => {
    const file = writeSession("5e8b3d2f-8c4e-4f9b-8d3a-2b6c7d8e9f02", false);
    const before = JSON.parse(fs.readFileSync(file, "utf8"));

    loadSession();
    saveSession();

    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(after.history[1].promptLogs).toEqual(before.history[1].promptLogs);
    expect(after.title).toBe("Saved in VS Code");
  });
});
