import { waitFor } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { ChatHistoryItem, ChatMessage, Session } from "core";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { Chat } from "../../pages/gui/Chat";
import { addAndSelectMockLlm } from "../../util/test/config";
import { renderWithProviders } from "../../util/test/render";
import {
  getMainEditor,
  sendInputWithMockedResponse,
} from "../../util/test/utils";
import { setActive, setToolGenerated } from "../slices/sessionSlice";
import { callToolById } from "./callToolById";
import { loadSession, saveCurrentSession } from "./session";
import { streamResponseThunk } from "./streamResponse";

/** A turn that stops mid-way through generating a tool call */
const HALF_TOOL_CALL: ChatMessage = {
  role: "assistant",
  content: "Let me look.",
  toolCalls: [
    {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"filepath":' },
    },
  ],
};

/** A tool call with complete arguments and no text */
const READ_FILE_CALL: ChatMessage = {
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id: "call_2",
      type: "function",
      function: { name: "read_file", arguments: '{"filepath":"a.ts"}' },
    },
  ],
};

async function renderChat() {
  const rendered = await renderWithProviders(<Chat />);
  await act(async () => {
    addAndSelectMockLlm(rendered.store, rendered.ideMessenger);
  });
  return rendered;
}

/**
 * Makes the next turn stream `chunks` and then keep running, like a model
 * that is still thinking, until something aborts it
 */
function holdNextTurn(ideMessenger: MockIdeMessenger, chunks: ChatMessage[]) {
  ideMessenger.llmStreamChat = async function* (_msg, signal) {
    for (const chunk of chunks) {
      yield [chunk];
    }
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    throw new Error("The operation was aborted.");
  };
}

async function startHeldTurn(
  rendered: Awaited<ReturnType<typeof renderChat>>,
  prompt: string,
  chunks: ChatMessage[],
) {
  const { ideMessenger, store } = rendered;
  holdNextTurn(ideMessenger, chunks);
  const historyBefore = store.getState().session.history.length;
  // Dispatched directly: after a turn there are two send buttons
  void store.dispatch(
    streamResponseThunk({
      editorState: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: prompt }] },
        ],
      },
      modifiers: { useCodebase: false, noContext: true },
    }),
  );
  // The user message and the assistant placeholder, plus the chunks
  await waitFor(() =>
    expect(store.getState().session.history.length).toBeGreaterThanOrEqual(
      historyBefore + 2,
    ),
  );
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(true));
}

function savedSession(
  request: { mock: { calls: unknown[][] } },
  sessionId: string,
): Session {
  const saves = request.mock.calls.filter(
    ([type, data]) =>
      type === "history/save" && (data as Session).sessionId === sessionId,
  );
  expect(saves.length).toBeGreaterThan(0);
  return saves.at(-1)![1] as Session;
}

function userTexts(history: ChatHistoryItem[]) {
  return history
    .filter((item) => item.message.role === "user")
    .map((item) => JSON.stringify(item.message.content));
}

async function newSessionFromRunningTurn(
  rendered: Awaited<ReturnType<typeof renderChat>>,
) {
  await act(async () => {
    await rendered.store.dispatch(
      saveCurrentSession({ openNewSession: true, generateTitle: false }),
    );
  });
}

test("a new session during a stream saves the turn as Stop would", async () => {
  const rendered = await renderChat();
  const { ideMessenger, store } = rendered;
  await startHeldTurn(rendered, "Read the file", [HALF_TOOL_CALL]);
  const request = vi.spyOn(ideMessenger, "request");

  await newSessionFromRunningTurn(rendered);

  const turn = savedSession(
    request,
    store.getState().session.lastSessionId!,
  ).history.at(-1)!;
  expect(turn.message.content).toBe("Let me look.");
  // Without the cancel this was saved as "generating" and spun forever
  expect(turn.toolCallStates?.[0].status).toBe("canceled");

  await waitFor(() => expect(store.getState().session.history).toEqual([]));
  expect(store.getState().session.isStreaming).toBe(false);
});

test("leaving a first turn before any answer still switches and keeps the prompt", async () => {
  const rendered = await renderChat();
  const { ideMessenger, store } = rendered;
  await startHeldTurn(rendered, "Find the hard part", []);
  const leftSessionId = store.getState().session.id;
  const request = vi.spyOn(ideMessenger, "request");

  await newSessionFromRunningTurn(rendered);

  // The switch happened, though the turn had nothing but the prompt
  expect(store.getState().session.id).not.toBe(leftSessionId);
  expect(store.getState().session.isStreaming).toBe(false);
  const saved = savedSession(request, leftSessionId);
  expect(saved.history.map((item) => item.message.role)).toEqual(["user"]);
  expect(userTexts(saved.history)[0]).toContain("Find the hard part");

  // The prompt is not moved into the new session's input box
  expect(store.getState().session.mainEditorContentTrigger).toBeUndefined();
  const editor = await getMainEditor();
  expect(editor.getText()).toBe("");
});

test("leaving a later turn before any answer keeps both prompts", async () => {
  const rendered = await renderChat();
  const { ideMessenger, store } = rendered;
  await sendInputWithMockedResponse(ideMessenger, "First question", [
    { role: "assistant", content: "First answer." },
  ]);
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));
  await startHeldTurn(rendered, "Second question", []);
  const leftSessionId = store.getState().session.id;
  const request = vi.spyOn(ideMessenger, "request");

  await newSessionFromRunningTurn(rendered);

  const saved = savedSession(request, leftSessionId);
  expect(saved.history.map((item) => item.message.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);
  expect(userTexts(saved.history)[1]).toContain("Second question");
  expect(store.getState().session.mainEditorContentTrigger).toBeUndefined();
});

test("leaving while the model only reasoned keeps the reasoning", async () => {
  const rendered = await renderChat();
  const { ideMessenger, store } = rendered;
  await startHeldTurn(rendered, "Think first", [
    { role: "thinking", content: "Looking at the call graph" },
  ]);
  const leftSessionId = store.getState().session.id;
  const request = vi.spyOn(ideMessenger, "request");

  await newSessionFromRunningTurn(rendered);

  const saved = savedSession(request, leftSessionId);
  expect(saved.history.map((item) => item.message.role)).toEqual([
    "user",
    "thinking",
  ]);
  expect(saved.history[1].message.content).toBe("Looking at the call graph");
});

test("leaving inside an open <think> block keeps it, closed", async () => {
  const rendered = await renderChat();
  const { ideMessenger, store } = rendered;
  await startHeldTurn(rendered, "Think first", [
    { role: "assistant", content: "<think>Tracing the session thunks" },
  ]);
  const leftSessionId = store.getState().session.id;
  const request = vi.spyOn(ideMessenger, "request");

  await newSessionFromRunningTurn(rendered);

  const turn = savedSession(request, leftSessionId).history.at(-1)!;
  expect(turn.reasoning?.text).toContain("Tracing the session thunks");
  expect(turn.reasoning?.active).toBe(false);
});

test("a tool still running is saved as stopped, and its late result goes nowhere", async () => {
  const rendered = await renderChat();
  const { ideMessenger, store } = rendered;
  await startHeldTurn(rendered, "Read a.ts", [READ_FILE_CALL]);
  const leftSessionId = store.getState().session.id;

  // The tool runs on the core side and hasn't returned yet
  let finishTool!: () => void;
  ideMessenger.responseHandlers["tools/call"] = () =>
    new Promise((resolve) => {
      finishTool = () =>
        resolve({
          contextItems: [{ name: "a.ts", description: "", content: "code" }],
        } as any);
    });
  const streamCalls = vi.spyOn(ideMessenger, "llmStreamChat");
  act(() => {
    store.dispatch(setToolGenerated({ toolCallId: "call_2", tools: [] }));
  });
  const toolRun = store.dispatch(callToolById({ toolCallId: "call_2" }));
  await waitFor(() => expect(finishTool).toBeDefined());
  expect(
    store
      .getState()
      .session.history.flatMap((item) => item.toolCallStates ?? [])
      .find((state) => state.toolCallId === "call_2")?.status,
  ).toBe("calling");
  const request = vi.spyOn(ideMessenger, "request");

  await newSessionFromRunningTurn(rendered);

  const savedTool = savedSession(request, leftSessionId)
    .history.flatMap((item) => item.toolCallStates ?? [])
    .find((state) => state.toolCallId === "call_2")!;
  expect(savedTool.status).toBe("errored");
  expect(savedTool.output?.[0].content).toContain(
    "switched while this tool was running",
  );

  // A turn starts in the new session; the old tool's result must not stop it
  act(() => {
    store.dispatch(setActive());
  });
  const newSessionHistory = store.getState().session.history;
  await act(async () => {
    finishTool();
    await toolRun;
  });
  expect(store.getState().session.isStreaming).toBe(true);
  expect(store.getState().session.history).toBe(newSessionHistory);
  expect(streamCalls).not.toHaveBeenCalled();
});

test("opening another session during a stream saves the turn as stopped", async () => {
  const rendered = await renderChat();
  const { ideMessenger, store } = rendered;
  await startHeldTurn(rendered, "Read the file", [HALF_TOOL_CALL]);
  const leftSessionId = store.getState().session.id;
  ideMessenger.responses["history/load"] = {
    sessionId: "other-session",
    title: "Other session",
    workspaceDirectory: "",
    history: [],
  };
  const request = vi.spyOn(ideMessenger, "request");

  await act(async () => {
    await store.dispatch(
      loadSession({ sessionId: "other-session", saveCurrentSession: true }),
    );
  });

  expect(store.getState().session.id).toBe("other-session");
  expect(store.getState().session.isStreaming).toBe(false);
  await waitFor(() => savedSession(request, leftSessionId));
  const turn = savedSession(request, leftSessionId).history.at(-1)!;
  expect(turn.message.content).toBe("Let me look.");
  expect(turn.toolCallStates?.[0].status).toBe("canceled");
  expect(store.getState().session.mainEditorContentTrigger).toBeUndefined();
});
