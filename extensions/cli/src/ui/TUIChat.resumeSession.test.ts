import fs from "fs";
import path from "path";

import type { ChatHistoryItem } from "core/index.js";
import { describe, expect, it, vi } from "vitest";

import { getCurrentSession, updateSessionHistory } from "../session.js";

import { loadAndSetSession } from "./TUIChat.js";

// vitest.global-dir-setup.ts gives each test file its own CONTINUE_GLOBAL_DIR,
// which both cn and core's HistoryManager use for sessions
const sessionFile = (sessionId: string) =>
  path.join(process.env.CONTINUE_GLOBAL_DIR!, "sessions", `${sessionId}.json`);

const item = (
  role: "user" | "assistant",
  content: string,
): ChatHistoryItem => ({
  message: { role, content },
  contextItems: [],
});

describe("/resume in the TUI", () => {
  it("saves the next turn to the chosen session, not the one it left", async () => {
    // The chat open before /resume, saved under its own id
    const current = getCurrentSession().sessionId;
    updateSessionHistory([item("user", "current chat")]);
    const currentBefore = fs.readFileSync(sessionFile(current), "utf8");

    const chosen = "0b7c2e9a-1d4f-4c3e-8a6b-5f2e9d8c7b10";
    fs.writeFileSync(
      sessionFile(chosen),
      JSON.stringify({
        sessionId: chosen,
        title: "Chosen chat",
        workspaceDirectory: process.cwd(),
        history: [item("user", "chosen chat"), item("assistant", "an answer")],
      }),
    );

    // The TUI's setChatHistory writes through the history service, which
    // saves to the current session
    await loadAndSetSession(
      chosen,
      vi.fn(),
      (history: ChatHistoryItem[]) => updateSessionHistory(history),
      vi.fn(),
    );
    updateSessionHistory([
      item("user", "chosen chat"),
      item("assistant", "an answer"),
      item("user", "follow-up"),
    ]);

    expect(getCurrentSession().sessionId).toBe(chosen);
    expect(fs.readFileSync(sessionFile(chosen), "utf8")).toContain("follow-up");
    expect(fs.readFileSync(sessionFile(current), "utf8")).toBe(currentBefore);
  });
});
