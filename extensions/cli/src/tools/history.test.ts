import path from "path";
import { pathToFileURL } from "url";

import { syncJournal } from "@nextcli/context/archive";
import { SqliteDatabase, sqliteHasFts5 } from "@nextcli/context/sqlite";
import type { ChatHistoryItem } from "core/index.js";
import { describe, expect, it } from "vitest";

import {
  getDefaultToolPolicies,
  getPlanModePolicies,
} from "../permissions/defaultPolicies.js";
import { checkToolPermission } from "../permissions/permissionChecker.js";
import {
  getCurrentSession,
  getSessionDir,
  startNewSession,
  updateSessionHistory,
} from "../session.js";

import { readHistoryTool, searchHistoryTool } from "./history.js";
import { Tool } from "./types.js";

// vitest.global-dir-setup.ts gives each test file its own CONTINUE_GLOBAL_DIR:
// cn saves sessions there, and core's HistoryManager writes their transcripts

const user = (content: string): ChatHistoryItem => ({
  message: { role: "user", content },
  contextItems: [],
});
const reply = (content: string): ChatHistoryItem => ({
  message: { role: "assistant", content },
  contextItems: [],
});
const read = (file: string, output: string): ChatHistoryItem => ({
  message: { role: "assistant", content: "" },
  contextItems: [],
  toolCallStates: [
    {
      toolCallId: file,
      status: "done",
      toolCall: {
        id: file,
        type: "function",
        function: { name: "Read", arguments: JSON.stringify({ file }) },
      },
      parsedArgs: { file },
      output: [{ name: file, description: file, content: output }],
    },
  ],
});

/** As the agent loop calls a tool: preprocess, then run */
async function call(tool: Tool, args: Record<string, unknown>) {
  const prepared = await tool.preprocess!(args);
  return tool.run(prepared.args);
}

/** A transcript of a session saved by another cn or by VS Code */
function otherSession(sessionId: string, workspace: string, text: string) {
  syncJournal(
    path.join(getSessionDir(), `${sessionId}.jsonl`),
    [user(text), reply("done")],
    { workspace },
  );
}

describe("SearchHistory and ReadHistory", () => {
  it("find a fact from before a compaction and read the turn back", async () => {
    startNewSession();
    updateSessionHistory([
      user("REQUIREMENT: keep the v1 API"),
      read(
        "src/auth/token.ts",
        "throws TOKEN_EXPIRED_419 when the clock skews",
      ),
      reply("Fixed the skew"),
    ]);
    // cn's compaction replaces the session with its summary
    updateSessionHistory([
      {
        ...reply("Summary of the fix"),
        conversationSummary: "Summary of the fix",
      },
      user("Continue"),
    ]);

    const found = await call(searchHistoryTool, { query: "TOKEN_EXPIRED_419" });
    const turns = await call(readHistoryTool, { from: 0, to: 1 });

    expect(found).toMatch(/^this session #1 \(assistant Read, compacted\):/);
    expect(turns).toContain(
      "#0 (compacted) user: REQUIREMENT: keep the v1 API",
    );
    expect(turns).toContain("TOKEN_EXPIRED_419");
  });

  it("search this session by default, this folder's or every session when asked", async () => {
    startNewSession();
    updateSessionHistory([user("nothing relevant here")]);
    otherSession("same-folder", process.cwd(), "the PLANTED_FACT here");
    // VS Code records the folder as a file:// URI
    otherSession(
      "vscode-same-folder",
      pathToFileURL(process.cwd()).href,
      "the PLANTED_FACT in VS Code",
    );
    otherSession("other-project", "/elsewhere", "the PLANTED_FACT there");

    const session = await call(searchHistoryTool, { query: "PLANTED_FACT" });
    const workspace = await call(searchHistoryTool, {
      query: "PLANTED_FACT",
      scope: "workspace",
    });
    const all = await call(searchHistoryTool, {
      query: "PLANTED_FACT",
      scope: "all",
    });

    expect(session).toBe('No match for "PLANTED_FACT".');
    expect(workspace).toContain("same-folder #0 (user)");
    expect(workspace).toContain("vscode-same-folder #0 (user)");
    expect(workspace).not.toContain("other-project");
    expect(all).toContain("other-project #0");
  });

  it("redact secrets in what they return", async () => {
    startNewSession();
    updateSessionHistory([
      user("export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234 and retry"),
    ]);

    const found = await call(searchHistoryTool, { query: "retry" });
    const turns = await call(readHistoryTool, { from: 0, to: 0 });

    expect(found).not.toContain("sk-proj");
    expect(turns).toBe("#0 user: export OPENAI_API_KEY=[redacted] and retry");
  });

  it("say where to read on when the size limit stops a read", async () => {
    startNewSession();
    updateSessionHistory([
      read("a.log", "a".repeat(30_000)),
      read("b.log", "b".repeat(30_000)),
      read("c.log", "c".repeat(30_000)),
    ]);

    const turns = await call(readHistoryTool, { from: 0, to: 2 });

    expect(turns).toContain("#1 assistant");
    expect(turns).not.toContain("#2 assistant");
    expect(turns).toMatch(/read from #2 for the rest\.$/);
  });

  it("say a read may be incomplete while the index is busy", async () => {
    startNewSession();
    updateSessionHistory([user("indexed before the lock")]);
    await call(readHistoryTool, { from: 0, to: 0 });
    updateSessionHistory([
      user("indexed before the lock"),
      reply("written while another process holds the index"),
    ]);
    // The tool's index, as another cn or a VS Code window would hold it
    const index = path.join(
      path.dirname(getSessionDir()),
      "index",
      sqliteHasFts5() ? "history.sqlite" : "history-basic.sqlite",
    );
    const other = await SqliteDatabase.open(index);
    await other.exec("BEGIN IMMEDIATE");
    let turns: string;
    try {
      turns = await call(readHistoryTool, { from: 0, to: 1 });
    } finally {
      await other.exec("ROLLBACK");
      await other.close();
    }

    expect(turns).toContain("#0 user: indexed before the lock");
    expect(turns).toMatch(/isn't fully indexed yet .*read again/);
    expect(await call(readHistoryTool, { from: 1, to: 1 })).toBe(
      "#1 assistant: written while another process holds the index",
    );
  });
});

describe("SearchHistory and ReadHistory permissions", () => {
  const permission = (
    name: string,
    args: Record<string, unknown>,
    policies = getDefaultToolPolicies(),
  ) => checkToolPermission({ name, arguments: args }, { policies }).permission;

  it("run without asking on this session in the terminal UI", () => {
    expect(permission("SearchHistory", { query: "x" })).toBe("allow");
    expect(
      permission("SearchHistory", { query: "x", scope: "workspace" }),
    ).toBe("allow");
    expect(
      permission("ReadHistory", {
        session: getCurrentSession().sessionId,
        from: 0,
        to: 3,
      }),
    ).toBe("allow");
    expect(
      permission("SearchHistory", { query: "x" }, getPlanModePolicies()),
    ).toBe("allow");
  });

  it("ask before reaching every session or another session's turns", () => {
    expect(permission("SearchHistory", { query: "x", scope: "all" })).toBe(
      "ask",
    );
    expect(
      permission("ReadHistory", { session: "another", from: 0, to: 3 }),
    ).toBe("ask");
  });

  it("are not offered where nobody is present", () => {
    expect(
      permission("SearchHistory", { query: "x" }, getDefaultToolPolicies(true)),
    ).toBe("exclude");
    expect(
      permission("ReadHistory", { from: 0, to: 1 }, getPlanModePolicies(true)),
    ).toBe("exclude");
  });
});
