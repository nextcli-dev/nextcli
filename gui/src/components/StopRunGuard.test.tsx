import { screen, waitFor } from "@testing-library/dom";
import { act, fireEvent } from "@testing-library/react";
import { ChatMessage, Session } from "core";
import { Route, Routes } from "react-router-dom";
import { Chat } from "../pages/gui/Chat";
import { useAppSelector } from "../redux/hooks";
import { setCodeToEdit } from "../redux/slices/editState";
import { setActive, setIsInEdit } from "../redux/slices/sessionSlice";
import { addAndSelectMockLlm, triggerConfigUpdate } from "../util/test/config";
import { renderWithProviders } from "../util/test/render";
import { getMainEditor, sendInputWithMockedResponse } from "../util/test/utils";
import { HistoryTableRow } from "./History/HistoryTableRow";
import Layout from "./Layout";

const OTHER_SESSION = {
  sessionId: "other-session",
  title: "Other session",
  dateCreated: "0",
  workspaceDirectory: "",
};

/** A History row for whichever session is open */
function CurrentSessionRow() {
  const sessionId = useAppSelector((state) => state.session.id);
  return (
    <HistoryTableRow
      sessionMetadata={{ ...OTHER_SESSION, sessionId, title: "Open session" }}
      index={1}
    />
  );
}

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
                  <CurrentSessionRow />
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
  // Every session loads as an empty one with the requested id
  ideMessenger.responseHandlers["history/load"] = async ({ id }) => ({
    ...OTHER_SESSION,
    sessionId: id,
    history: [],
  });
  return rendered;
}

/**
 * Starts a turn that streams `chunks` and then keeps running until
 * something aborts it. With no chunks it is still waiting for the model.
 */
async function startRunningTurn(
  rendered: Awaited<ReturnType<typeof renderWithTabs>>,
  chunks: ChatMessage[] = [
    { role: "thinking", content: "Looking at the code" },
  ],
) {
  const { ideMessenger, store } = rendered;
  ideMessenger.llmStreamChat = async function* (_msg, signal) {
    for (const chunk of chunks) {
      yield [chunk];
    }
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    throw new Error("The operation was aborted.");
  };
  await sendInputWithMockedResponse(ideMessenger, "Find the hard part", []);
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(true));
  if (chunks.length) {
    await waitFor(() =>
      expect(store.getState().session.history.at(-1)?.message.role).toBe(
        chunks.at(-1)!.role,
      ),
    );
  } else {
    await screen.findByTestId("waiting-for-model");
  }
}

function savedSession(
  request: { mock: { calls: unknown[][] } },
  sessionId: string,
): Session | undefined {
  return request.mock.calls.findLast(
    ([type, data]) =>
      type === "history/save" && (data as Session).sessionId === sessionId,
  )?.[1] as Session | undefined;
}

async function stopAndSwitch() {
  await screen.findByText("Stop the running turn?");
  fireEvent.click(screen.getByText("Stop and switch"));
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

test("Stop and switch while waiting for the model opens a new tab with an empty input", async () => {
  const rendered = await renderWithTabs();
  const { store, ideMessenger } = rendered;
  await startRunningTurn(rendered, []);
  const leftSessionId = store.getState().session.id;
  const request = vi.spyOn(ideMessenger, "request");

  clickNewSession(rendered);
  await stopAndSwitch();

  await waitFor(() =>
    expect(store.getState().session.id).not.toBe(leftSessionId),
  );
  const tabs = store.getState().tabs.tabs;
  expect(tabs).toHaveLength(2);
  expect(tabs.find((tab) => tab.isActive)?.sessionId).toBe(
    store.getState().session.id,
  );
  // The prompt stays with the session it was asked in
  const saved = savedSession(request, leftSessionId);
  expect(saved?.history.map((item) => item.message.role)).toEqual(["user"]);
  const editor = await getMainEditor();
  expect(editor.getText()).toBe("");
});

test("Stop and switch from a tab click opens that tab", async () => {
  const rendered = await renderWithTabs();
  const { store, ideMessenger } = rendered;
  await sendInputWithMockedResponse(ideMessenger, "First question", [
    { role: "assistant", content: "First answer." },
  ]);
  await waitFor(() => expect(store.getState().session.isStreaming).toBe(false));
  clickNewSession(rendered);
  await waitFor(() => expect(store.getState().tabs.tabs).toHaveLength(2));
  await startRunningTurn(rendered);
  const runningSessionId = store.getState().session.id;
  const request = vi.spyOn(ideMessenger, "request");

  const firstTab = store.getState().tabs.tabs.find((tab) => !tab.isActive)!;
  fireEvent.click(screen.getByText(firstTab.title));
  await stopAndSwitch();

  await waitFor(() =>
    expect(store.getState().session.id).toBe(firstTab.sessionId),
  );
  expect(store.getState().session.isStreaming).toBe(false);
  expect(store.getState().tabs.tabs.find((tab) => tab.isActive)?.id).toBe(
    firstTab.id,
  );
  await waitFor(() =>
    expect(savedSession(request, runningSessionId)).toBeDefined(),
  );
});

test("Stop and switch from a History row opens that session", async () => {
  const rendered = await renderWithTabs();
  const { store, ideMessenger } = rendered;
  await startRunningTurn(rendered);
  const runningSessionId = store.getState().session.id;
  const request = vi.spyOn(ideMessenger, "request");

  fireEvent.click(screen.getByTestId("history-row-0"));
  await stopAndSwitch();

  await waitFor(() =>
    expect(store.getState().session.id).toBe(OTHER_SESSION.sessionId),
  );
  expect(store.getState().session.isStreaming).toBe(false);
  await waitFor(() =>
    expect(savedSession(request, runningSessionId)).toBeDefined(),
  );
});

test("New Session during a running edit asks first", async () => {
  const rendered = await renderWithTabs();
  const { store } = rendered;
  act(() => {
    store.dispatch(
      setCodeToEdit({
        codeToEdit: { filepath: "file:///a.ts", contents: "const a = 1;" },
      }),
    );
    store.dispatch(setIsInEdit(true));
    store.dispatch(setActive());
  });

  clickNewSession(rendered);

  await screen.findByText("Stop the running turn?");
  expect(store.getState().session.isInEdit).toBe(true);
  expect(store.getState().session.isStreaming).toBe(true);
});

test("deleting the open session during a turn asks first", async () => {
  const rendered = await renderWithTabs();
  const { store, ideMessenger } = rendered;
  await startRunningTurn(rendered);
  const request = vi.spyOn(ideMessenger, "request");

  fireEvent.mouseEnter(screen.getByTestId("history-row-1"));
  fireEvent.click(await screen.findByTestId("history-delete-1"));

  await screen.findByText("Stop the running turn?");
  expect(request).not.toHaveBeenCalledWith("history/delete", expect.anything());
  expect(store.getState().session.isStreaming).toBe(true);
});
