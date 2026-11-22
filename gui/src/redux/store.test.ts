import { describe, expect, it } from "vitest";
import { setConfigLoading } from "./slices/configSlice";
import { setModelSettings } from "./slices/modelSettingsSlice";
import {
  INITIAL_SESSION_STATE,
  newSession,
  setMode,
} from "./slices/sessionSlice";
import { INITIAL_TABS_STATE, setTabs } from "./slices/tabsSlice";
import { setToolPolicy } from "./slices/uiSlice";
import { resetRootState, setupStore } from "./store";

describe("resetRootState", () => {
  it("clears in-memory state that a new session keeps", () => {
    const store = setupStore({});
    store.dispatch(setMode("plan"));
    store.dispatch(setConfigLoading(true));
    store.dispatch(
      setModelSettings({
        "openai/gpt": {
          key: "openai/gpt",
          fast: false,
          contextLength: 8000,
          stored: {},
        },
      }),
    );
    store.dispatch(
      setToolPolicy({ toolName: "ask_question", policy: "disabled" }),
    );
    store.dispatch(setTabs([{ id: "kept", title: "Kept", isActive: true }]));
    store.dispatch(
      newSession({
        sessionId: "crashed",
        title: "Crashed",
        workspaceDirectory: "",
        history: [
          {
            message: { role: "user", content: "hi" },
            contextItems: [],
          },
        ],
      }),
    );
    const crashed = store.getState().session.streamAborter;

    store.dispatch(resetRootState());

    const state = store.getState();
    expect(crashed.signal.aborted).toBe(true);
    expect(state.session.history).toEqual([]);
    expect(state.session.mode).toBe(INITIAL_SESSION_STATE.mode);
    expect(state.session.title).toBe(INITIAL_SESSION_STATE.title);
    expect(state.session.id).not.toBe("crashed");
    expect(state.session.streamAborter).not.toBe(crashed);
    expect(state.session.streamAborter.signal.aborted).toBe(false);
    expect(state.ui.toolSettings).toEqual({});
    expect(state.tabs).toEqual(INITIAL_TABS_STATE);
    // Host-owned. Recovery does not ask the IDE for them again.
    expect(state.config.loading).toBe(true);
    expect(state.modelSettings.byKey["openai/gpt"]?.contextLength).toBe(8000);
  });
});
