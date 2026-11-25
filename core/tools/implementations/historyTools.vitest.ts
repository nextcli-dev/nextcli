import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";

import { ChatHistoryItem, Session, Tool, ToolExtras } from "../..";
import historyManager from "../../util/history";
import { callBuiltInTool } from "../callTool";
import { BuiltInToolNames } from "../builtIn";
import { getBaseToolDefinitions } from "../index";

const item = (role: "user" | "assistant", content: string) =>
  ({
    message: { role, content },
    contextItems: [],
  }) as unknown as ChatHistoryItem;

function save(
  sessionId: string,
  history: ChatHistoryItem[],
  workspaceDirectory = "file:///work/project",
) {
  historyManager.save({
    sessionId,
    title: "t",
    workspaceDirectory,
    history,
  } as Session);
}

const extrasFor = (
  sessionId: string | undefined,
  workspaceDirs: string[] = ["file:///work/project"],
) =>
  ({
    sessionId,
    ide: { getWorkspaceDirs: async () => workspaceDirs },
  }) as unknown as ToolExtras;

const search = async (
  args: Record<string, unknown>,
  extras: ToolExtras,
): Promise<string> =>
  (await callBuiltInTool(BuiltInToolNames.SearchHistory, args, extras))
    .map((i) => i.content)
    .join("\n");

const read = async (
  args: Record<string, unknown>,
  extras: ToolExtras,
): Promise<string> =>
  (await callBuiltInTool(BuiltInToolNames.ReadHistory, args, extras))
    .map((i) => i.content)
    .join("\n");

describe("search_history and read_history", () => {
  it("finds a fact from before a compaction and reads it back", async () => {
    const id = uuidv4();
    const marker = `zephyrquartz${id.slice(0, 8)}`;
    save(id, [
      item("user", `REQUIREMENT ${marker}: keep the public API`),
      item("assistant", "Understood"),
    ]);
    // The compaction replaces both turns with a summary
    save(id, [
      {
        ...item("assistant", "Summary of the work"),
        conversationSummary: "Summary of the work",
      } as ChatHistoryItem,
      item("user", "Continue"),
    ]);

    const found = await search({ query: marker }, extrasFor(id));
    expect(found).toMatch(/this session #0 \(user, compacted\)/);
    expect(found).toContain("REQUIREMENT");

    const text = await read({ from: 0, to: 1 }, extrasFor(id));
    expect(text).toContain(`#0 (compacted) user: REQUIREMENT ${marker}`);
    expect(text).toContain("#1 (compacted) assistant: Understood");
  });

  it("redacts secrets when reading", async () => {
    const id = uuidv4();
    save(id, [
      item(
        "user",
        "my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      ),
    ]);
    const text = await read({ from: 0 }, extrasFor(id));
    expect(text).toContain("my key is");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("session scope does not see another session", async () => {
    const mine = uuidv4();
    const other = uuidv4();
    const marker = `otherfact${other.slice(0, 8)}`;
    save(mine, [item("user", "nothing here")]);
    save(other, [item("user", `the ${marker} lives elsewhere`)]);

    expect(await search({ query: marker }, extrasFor(mine))).toContain(
      "No matches",
    );
    expect(
      await search({ query: marker, scope: "all" }, extrasFor(mine)),
    ).toContain(`session ${other} (`);
  });

  it("session scope without a session id is an error item", async () => {
    const result = await search({ query: "anything" }, extrasFor(undefined));
    expect(result).toMatch(/^Error: .*session/);
  });

  it("workspace scope finds sessions of the workspace, in whatever form its folder is written", async () => {
    const marker = `wsfact${uuidv4().slice(0, 8)}`;
    const inside = uuidv4();
    const outside = uuidv4();
    const viewer = uuidv4();
    save(
      inside,
      [item("user", `${marker} inside`)],
      "file:///c%3A/My%20Work/app",
    );
    save(outside, [item("user", `${marker} outside`)], "file:///elsewhere");
    save(viewer, [item("user", "x")]);

    const extras = extrasFor(viewer, ["file:///C:/My Work/app"]);
    const result = await search({ query: marker, scope: "workspace" }, extras);
    expect(result).toContain(`session ${inside}`);
    expect(result).not.toContain(outside);

    const none = await search(
      { query: marker, scope: "workspace" },
      extrasFor(viewer, ["file:///unrelated"]),
    );
    expect(none).toContain("No saved conversations");
  });

  it("rejects a session id that is not a file name", async () => {
    expect(
      await read({ session: "../x", from: 0 }, extrasFor(uuidv4())),
    ).toMatch(/^Error: .*not a session id/);
  });
});

describe("history tool policies", () => {
  const tool = (name: BuiltInToolNames): Tool =>
    getBaseToolDefinitions().find((t) => t.function.name === name)!;

  it("are offered, read-only and allowed without permission by default", () => {
    for (const name of [
      BuiltInToolNames.SearchHistory,
      BuiltInToolNames.ReadHistory,
    ]) {
      expect(tool(name).readonly).toBe(true);
      expect(tool(name).defaultToolPolicy).toBe("allowedWithoutPermission");
    }
  });

  it("search_history asks for scope all only", () => {
    const { evaluateToolCallPolicy } = tool(BuiltInToolNames.SearchHistory);
    const base = "allowedWithoutPermission";
    expect(evaluateToolCallPolicy!(base, { query: "x", scope: "all" })).toBe(
      "allowedWithPermission",
    );
    expect(
      evaluateToolCallPolicy!(base, { query: "x", scope: "session" }),
    ).toBe("allowedWithoutPermission");
    expect(evaluateToolCallPolicy!(base, { query: "x" })).toBe(
      "allowedWithoutPermission",
    );
    expect(evaluateToolCallPolicy!("disabled", { scope: "all" })).toBe(
      "disabled",
    );
  });

  it("read_history asks for another session only", () => {
    const { evaluateToolCallPolicy } = tool(BuiltInToolNames.ReadHistory);
    const base = "allowedWithoutPermission";
    expect(evaluateToolCallPolicy!(base, { from: 1 })).toBe(
      "allowedWithoutPermission",
    );
    expect(evaluateToolCallPolicy!(base, { from: 1, session: "abc" })).toBe(
      "allowedWithPermission",
    );
  });
});
