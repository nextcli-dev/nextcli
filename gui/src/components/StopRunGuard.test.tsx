import { screen, waitFor } from "@testing-library/dom";
import { act, fireEvent } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { Chat } from "../pages/gui/Chat";
import { addAndSelectMockLlm, triggerConfigUpdate } from "../util/test/config";
import { renderWithProviders } from "../util/test/render";
import { sendInputWithMockedResponse } from "../util/test/utils";
import { HistoryTableRow } from "./History/HistoryTableRow";
import Layout from "./Layout";

const OTHER_SESSION = {
  sessionId: "other-session",
  title: "Other session",
  dateCreated: "0",
  workspaceDirectory: "",
};

async function renderWithTabs() {
  const rendered = await renderWithProviders(
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route
          index
          element={
            <>
              <Chat />
              <table>
                <tbody>
                  <HistoryTableRow sessionMetadata={OTHER_SESSION} index={0} />
                </tbody>
              </table>
            </>
          }
        />
      </Route>
    </Routes>,
  );
  const { store, ideMessenger } = rendered;
  await act(async () => {
    addAndSelectMockLlm(store, ideMessenger);
    triggerConfigUpdate({
      store,
      ideMessenger,
      editConfig: (config) => ({
        ...config,
        ui: { ...config.ui, showSessionTabs: true },
      }),
    });
  });
  ideMessenger.responses["history/load"] = {
    ...OTHER_SESSION,
    history: [],
  };
  return rendered;
}

/** Starts a turn that keeps thinking until something aborts it */
async function startRunningTurn(
  rendered: Awaited<ReturnType<typeof renderWithTabs>>,
) {
  const { ideMessenger, store } = rendered;
  ideMessenger.llmStreamChat = async function* (_msg, signal) {
    yield [{ role: "thinking", content: "Looking at the code" }];
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    throw new Error("The operation was aborted.");
  };
  await sendInputWithMockedResponse(ideMessenger, "Find the hard part", []);
  await waitFor(() =>
    expect(store.getState().session.history.at(-1)?.message.role).toBe(
      "thinking",
    ),
  );
  expect(store.getState().session.isStreaming).toBe(true);
}

function clickNewSession(rendered: Awaited<ReturnType<typeof renderWithTabs>>) {
  act(() => {
    rendered.ideMessenger.mockMessageToWebview("newSession", undefined);
  });
}

test("New Session with no running turn switches at once", async () => {
  const rendered = await renderWithTabs();
  const { store, ideMessenger } = rendered;
  await sendInputWithMockedResponse(ideMessenger, "First question", [
    { role: "assistant", content: "First answer." },
  ]);
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));
  const firstSessionId = store.getState().session.id;

  clickNewSession(rendered);

  await waitFor(() =>
    expect(store.getState().session.id).not.toBe(firstSessionId),
  );
  expect(screen.queryByText("Stop the running turn?")).not.toBeInTheDocument();
  expect(store.getState().tabs.tabs).toHaveLength(2);
});

test("Keep running leaves the running turn and its tab alone", async () => {
  const rendered = await renderWithTabs();
  const { store } = rendered;
  await startRunningTurn(rendered);
  const sessionId = store.getState().session.id;
  const historyLength = store.getState().session.history.length;

  clickNewSession(rendered);
  await screen.findByText("Stop the running turn?");
  fireEvent.click(screen.getByText("Keep running"));

  await waitFor(() =>
    expect(
      screen.queryByText("Stop the running turn?"),
    ).not.toBeInTheDocument(),
  );
  const session = store.getState().session;
  expect(session.id).toBe(sessionId);
  expect(session.history).toHaveLength(historyLength);
  expect(session.isStreaming).toBe(true);
  expect(store.getState().tabs.tabs).toHaveLength(1);
});

test("Stop and switch saves the stopped turn and opens a new tab", async () => {
  const rendered = await renderWithTabs();
  const { store, ideMessenger } = rendered;
  await startRunningTurn(rendered);
  const sessionId = store.getState().session.id;
  const request = vi.spyOn(ideMessenger, "request");

  clickNewSession(rendered);
  await screen.findByText("Stop the running turn?");
  fireEvent.click(screen.getByText("Stop and switch"));

  await waitFor(() => expect(store.getState().session.id).not.toBe(sessionId));
  expect(store.getState().session.isStreaming).toBe(false);
  const saved = request.mock.calls.find(
    ([type, data]) =>
      type === "history/save" && (data as any).sessionId === sessionId,
  );
  expect(saved).toBeDefined();
  const tabs = store.getState().tabs.tabs;
  expect(tabs).toHaveLength(2);
  expect(tabs.find((tab) => tab.isActive)?.sessionId).toBe(
    store.getState().session.id,
  );
});

test("switching tabs or opening a History session asks first", async () => {
  const rendered = await renderWithTabs();
  const { store, ideMessenger } = rendered;

  // Two tabs: a finished first session, then a running turn in the second
  await sendInputWithMockedResponse(ideMessenger, "First question", [
    { role: "assistant", content: "First answer." },
  ]);
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));
  clickNewSession(rendered);
  await waitFor(() => expect(store.getState().tabs.tabs).toHaveLength(2));
  await startRunningTurn(rendered);
  const sessionId = store.getState().session.id;

  const firstTab = store.getState().tabs.tabs.find((tab) => !tab.isActive)!;
  fireEvent.click(screen.getByText(firstTab.title));
  await screen.findByText("Stop the running turn?");
  fireEvent.click(screen.getByText("Keep running"));

  fireEvent.click(screen.getByTestId("history-row-0"));
  await screen.findByText("Stop the running turn?");
  fireEvent.click(screen.getByText("Keep running"));

  await waitFor(() =>
    expect(
      screen.queryByText("Stop the running turn?"),
    ).not.toBeInTheDocument(),
  );
  expect(store.getState().session.id).toBe(sessionId);
  expect(store.getState().session.isStreaming).toBe(true);
});
