import { act, screen, waitFor } from "@testing-library/react";
import { ChatMessage } from "core";
import { viewDiffTool } from "core/tools/definitions/viewDiff";
import { vi } from "vitest";
import { generateToolCallButtonTestId } from "../../../components/mainInput/Lump/LumpToolbar/PendingToolCallToolbar";
import { updateConfig } from "../../../redux/slices/configSlice";
import { setToolPolicy } from "../../../redux/slices/uiSlice";
import { addAndSelectMockLlm } from "../../../util/test/config";
import { renderWithProviders } from "../../../util/test/render";
import {
  getElementByTestId,
  sendInputWithMockedResponse,
} from "../../../util/test/utils";
import { Chat } from "../Chat";

const TOOL_CALL_ID = "test_id";

const ASKS_FOR_VIEW_DIFF: ChatMessage[] = [
  { role: "assistant", content: "I'm going to call a tool:" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: TOOL_CALL_ID,
        type: "function",
        function: { name: viewDiffTool.function.name, arguments: "{}" },
      },
    ],
  },
];

/** Renders the chat with a view_diff call waiting for approval */
async function renderWithPendingViewDiff() {
  const rendered = await renderWithProviders(<Chat />);
  const { ideMessenger, store } = rendered;
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
    store.dispatch(
      updateConfig({
        ...store.getState().config.config,
        tools: [viewDiffTool],
      }),
    );
    // "Ask First"; view_diff runs without asking by default
    store.dispatch(
      setToolPolicy({
        toolName: viewDiffTool.function.name,
        policy: "allowedWithPermission",
      }),
    );
  });
  ideMessenger.responses["tools/call"] = {
    contextItems: [
      {
        name: "Diff",
        description: "git diff",
        content: "no changes",
        hidden: false,
      },
    ],
    errorMessage: undefined,
  };
  const request = vi.spyOn(ideMessenger, "request");

  await sendInputWithMockedResponse(ideMessenger, "Hello", ASKS_FOR_VIEW_DIFF);
  await getElementByTestId(
    generateToolCallButtonTestId("accept", TOOL_CALL_ID),
  );
  // The turn after the tool call
  ideMessenger.chatResponse = [{ role: "assistant", content: "Diff checked" }];
  return { ...rendered, request };
}

const toolCallsSent = (request: { mock: { calls: unknown[][] } }) =>
  request.mock.calls.filter(([type]) => type === "tools/call");

test("accepting a pending tool call runs it and continues the turn", async () => {
  const { request } = await renderWithPendingViewDiff();
  expect(toolCallsSent(request)).toHaveLength(0);

  await act(async () => {
    (
      await getElementByTestId(
        generateToolCallButtonTestId("accept", TOOL_CALL_ID),
      )
    ).click();
  });

  await waitFor(() => expect(toolCallsSent(request)).toHaveLength(1));
  expect(toolCallsSent(request)[0][1]).toMatchObject({
    toolCall: { id: TOOL_CALL_ID },
  });
  await screen.findByText("Diff checked");
  expect(screen.getByTestId("tool-call-title")).toHaveTextContent(
    "NextCLI viewed the git diff",
  );
});

test("rejecting a pending tool call doesn't run it", async () => {
  const { request } = await renderWithPendingViewDiff();

  await act(async () => {
    (
      await getElementByTestId(
        generateToolCallButtonTestId("reject", TOOL_CALL_ID),
      )
    ).click();
  });

  await waitFor(() =>
    expect(screen.getByTestId("tool-call-title")).toHaveTextContent(
      "NextCLI tried to view the git diff",
    ),
  );
  expect(toolCallsSent(request)).toHaveLength(0);
  expect(
    screen.queryByTestId(generateToolCallButtonTestId("accept", TOOL_CALL_ID)),
  ).not.toBeInTheDocument();
});
