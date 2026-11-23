import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MockIdeMessenger } from "../context/MockIdeMessenger";
import {
  newSession,
  setContextMeasuredFor,
  setContextSnapshot,
  setIsPruned,
  setMode,
} from "../redux/slices/sessionSlice";
import { setupStore } from "../redux/store";
import { renderWithProviders } from "../util/test/render";
import ContextPage from "./context";

const TOOLS = [
  ["multi_edit", 776],
  ["ask_question", 477],
  ["run_terminal_command", 240],
  ["grep_search", 122],
  ["create_new_file", 115],
  ["ls", 99],
  ["read_file", 86],
] as const;

const SNAPSHOT = {
  window: 983_000,
  used: 49_804,
  threshold: {
    tokens: 862_000,
    action: "pruning" as const,
    steps: [
      { label: "Model window", tokens: 983_000 },
      { label: "Reserved for the reply", tokens: -120_000 },
      { label: "Safety buffer", tokens: -1_000 },
    ],
  },
  segments: [
    {
      id: "system",
      label: "System prompt",
      tokens: 175,
      source: "estimated" as const,
      children: [
        {
          id: "system-0",
          label: "Base instructions",
          tokens: 171,
          source: "estimated" as const,
        },
      ],
    },
    {
      id: "tools",
      label: "Tool definitions",
      tokens: 1_939,
      source: "estimated" as const,
      children: [
        {
          id: "tools-Built-In",
          label: "Built-In",
          tokens: 1_915,
          source: "estimated" as const,
          children: TOOLS.map(([name, tokens]) => ({
            id: `tool-${name}`,
            label: name,
            tokens,
            source: "estimated" as const,
          })),
        },
      ],
    },
    {
      id: "history",
      label: "Conversation",
      tokens: 47_690,
      source: "estimated" as const,
      children: [
        {
          id: "history-user",
          label: "User",
          tokens: 50,
          source: "estimated" as const,
        },
        {
          id: "history-assistant",
          label: "Assistant",
          tokens: 7_935,
          source: "estimated" as const,
        },
        {
          id: "history-tool",
          label: "Tool results",
          tokens: 39_705,
          source: "estimated" as const,
        },
      ],
    },
  ],
  largestToolResults: [
    { label: "run_terminal_command", tokens: 6_990, toolCallId: "call_b" },
  ],
};

function setup() {
  const ideMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger });
  store.dispatch(
    newSession({
      sessionId: "s",
      title: "t",
      workspaceDirectory: "",
      history: [
        {
          message: { role: "user", content: "Fix it", id: "u1" },
          contextItems: [],
        },
        {
          message: { role: "assistant", content: "Reading", id: "a1" },
          contextItems: [],
          promptLogs: [
            {
              modelTitle: "Qwen 4.0",
              modelProvider: "qwen",
              prompt: "",
              completion: "",
              usage: { promptTokens: 30_000, completionTokens: 400 },
              costUsd: 0.12,
              priced: "catalog",
            },
          ],
        },
        {
          message: { role: "assistant", content: "Testing", id: "a2" },
          contextItems: [],
          toolCallStates: [
            {
              toolCallId: "call_b",
              toolCall: {
                id: "call_b",
                type: "function",
                function: { name: "run_terminal_command", arguments: "{}" },
              },
              status: "done",
              parsedArgs: {},
            },
          ],
          promptLogs: [
            {
              modelTitle: "Local coder",
              modelProvider: "ollama",
              prompt: "",
              completion: "",
              usage: { promptTokens: 38_472, completionTokens: 920 },
            },
          ],
        },
      ] as any,
    }),
  );
  return { ideMessenger, store };
}

describe("ContextPage", () => {
  it("lays out what fills the next request, largest first, and adds each group up", async () => {
    const { ideMessenger, store } = setup();
    store.dispatch(setContextSnapshot(SNAPSHOT));
    const { user } = await renderWithProviders(<ContextPage />, {
      store,
      mockIdeMessenger: ideMessenger,
    });

    expect(screen.getByText("5% full")).toBeInTheDocument();
    expect(screen.getByText("~49.8K / 983K tokens")).toBeInTheDocument();

    // Conversation is open by default, its parts sorted by size
    const conversationRows = screen
      .getAllByText(/^(User|Assistant|Tool results)$/)
      .map((el) => el.textContent);
    expect(conversationRows).toEqual(["Tool results", "Assistant", "User"]);

    // The tool group opens to its five largest tools, then all of them
    await user.click(screen.getByText("Built-In"));
    expect(screen.getByText("multi_edit")).toBeInTheDocument();
    expect(screen.queryByText("read_file")).toBeNull();
    await user.click(screen.getByText("Show all 7"));
    expect(screen.getByText("read_file")).toBeInTheDocument();

    // The part no child covers is shown, so the group adds up: 1,939 − 1,915
    await user.click(screen.getByText("System prompt"));
    const overheads = screen.getAllByText("Overhead");
    const overheadValues = overheads.map(
      // The row is the label's nearest div; its last cell is the count
      (el) => el.closest("div")!.lastElementChild!.textContent,
    );
    expect(overheadValues).toEqual(expect.arrayContaining(["4", "24"]));

    // The largest tool result names the response that made the call
    expect(screen.getByText("· response 2")).toBeInTheDocument();
    expect(screen.getByText("Pruning starts at")).toBeInTheDocument();
    expect(screen.getByText("862,000")).toBeInTheDocument();
    // Both figures are the last request: estimated, and counted by the provider
    expect(screen.getByText("Estimated by NextCLI")).toBeInTheDocument();
    expect(screen.getByText("38,472")).toBeInTheDocument();
    // The next request also sends that reply, which neither figure includes
    expect(
      screen.getByText(/next request also sends this reply, about 920 more/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Next request/)).toBeNull();
  });

  it("drops the breakdown after a change of mode, until the next request", async () => {
    const { ideMessenger, store } = setup();
    store.dispatch(setContextSnapshot(SNAPSHOT));
    store.dispatch(setContextMeasuredFor({ model: "Qwen 4.0", mode: "agent" }));
    store.dispatch(setMode("chat"));
    await renderWithProviders(<ContextPage />, {
      store,
      mockIdeMessenger: ideMessenger,
    });

    expect(
      screen.getByText(/Measured when you send the next message/),
    ).toBeInTheDocument();
    expect(screen.queryByText("5% full")).toBeNull();
  });

  it("explains a pruned request", async () => {
    const { ideMessenger, store } = setup();
    store.dispatch(
      setContextSnapshot({
        ...SNAPSHOT,
        pruned: { messages: 14, tokens: 212_400 },
      }),
    );
    store.dispatch(setIsPruned(true));
    await renderWithProviders(<ContextPage />, {
      store,
      mockIdeMessenger: ideMessenger,
    });

    expect(
      screen.getByText("Older messages were left out."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/14 messages \(212\.4K tokens\) didn’t fit/),
    ).toBeInTheDocument();
  });

  it("shows each model's session usage, and no price where it is unknown", async () => {
    const { ideMessenger, store } = setup();
    const { user } = await renderWithProviders(<ContextPage />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    // No snapshot yet: the context tab says when it will be measured
    expect(
      screen.getByText(/Measured when you send the next message/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Session usage" }));
    const local = screen.getByText("Local coder").closest("button")!;
    expect(within(local).getByText("Not priced")).toBeInTheDocument();
    const qwen = screen.getByText("Qwen 4.0").closest("button")!;
    expect(within(qwen).getByText("$0.12")).toBeInTheDocument();
    // The total counts only what is priced, and says what isn't
    expect(screen.getByText("1 not priced")).toBeInTheDocument();
    expect(screen.getByText(/Counts the 2 chat responses/)).toBeInTheDocument();

    await act(async () => {
      await user.click(local);
    });
    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getByText("ollama")).toBeInTheDocument();
  });
});
