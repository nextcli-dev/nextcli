import { waitFor } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { ChatMessage, Session } from "core";
import { Chat } from "../../pages/gui/Chat";
import { addAndSelectMockLlm } from "../../util/test/config";
import { renderWithProviders } from "../../util/test/render";
import { sendInputWithMockedResponse } from "../../util/test/utils";
import { saveCurrentSession } from "./session";

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

test("a new session during a stream saves the turn as Stop would", async () => {
  const { ideMessenger, store } = await renderWithProviders(<Chat />);
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
  });

  // Holds the stream open after the first chunk, like a model still writing
  let streamStarted!: () => void;
  const started = new Promise<void>((resolve) => (streamStarted = resolve));
  ideMessenger.llmStreamChat = async function* (_msg, signal) {
    yield [HALF_TOOL_CALL];
    streamStarted();
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    return undefined;
  };

  const request = vi.spyOn(ideMessenger, "request");
  await sendInputWithMockedResponse(ideMessenger, "Read the file", []);
  await act(async () => started);
  expect(store.getState().session.isStreaming).toBe(true);

  await act(async () => {
    await store.dispatch(
      saveCurrentSession({ openNewSession: true, generateTitle: false }),
    );
  });

  const saveCall = request.mock.calls.find(([type]) => type === "history/save");
  expect(saveCall).toBeDefined();
  const saved = saveCall![1] as Session;
  const turn = saved.history.at(-1)!;
  expect(turn.message.content).toBe("Let me look.");
  // Without the cancel this was saved as "generating" and spun forever
  expect(turn.toolCallStates?.[0].status).toBe("canceled");

  await waitFor(() => expect(store.getState().session.history).toEqual([]));
  expect(store.getState().session.isStreaming).toBe(false);
});
