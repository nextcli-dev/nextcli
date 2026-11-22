import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  newSession,
  setActive,
  setCompactionLoading,
  setInactive,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import ResponseActions from "./ResponseActions";

const history = [
  { message: { role: "user", content: "Fix it", id: "u1" }, contextItems: [] },
  {
    message: { role: "assistant", content: "Fixed", id: "a1" },
    contextItems: [],
  },
];

describe("ResponseActions", () => {
  it("can't compact while a turn runs or while that message compacts", async () => {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: history as any,
      }),
    );
    await renderWithProviders(
      <ResponseActions
        isTruncated={false}
        onContinueGeneration={() => {}}
        index={1}
        onDelete={() => {}}
        item={history[1] as any}
        isLast
      />,
      { store, mockIdeMessenger: ideMessenger },
    );
    const button = () => screen.getByTestId("compact-button-1");
    expect(button()).toBeEnabled();

    act(() => {
      store.dispatch(setActive());
    });
    expect(button()).toBeDisabled();

    act(() => {
      store.dispatch(setInactive());
      store.dispatch(setCompactionLoading({ messageId: "a1", loading: true }));
    });
    expect(button()).toBeDisabled();

    act(() => {
      store.dispatch(setCompactionLoading({ messageId: "a1", loading: false }));
    });
    expect(button()).toBeEnabled();
  });
});
