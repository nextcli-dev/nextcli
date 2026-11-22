import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  newSession,
  setActive,
  setInactive,
  setIsPruned,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import ContextStatus from "./ContextStatus";

describe("ContextStatus", () => {
  // Tooltips render into this element (Layout adds it in the app)
  let portal: HTMLDivElement;
  beforeEach(() => {
    portal = document.createElement("div");
    portal.id = "tooltip-portal-div";
    document.body.appendChild(portal);
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(() => ({ observe() {}, unobserve() {}, disconnect() {} })),
    );
  });
  afterEach(() => {
    portal.remove();
    vi.unstubAllGlobals();
  });

  it("stays mounted when the first message of a session arrives", async () => {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: [],
      }),
    );
    const { container } = await renderWithProviders(<ContextStatus />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    expect(container.querySelector("svg")).toBeNull();

    act(() => {
      store.dispatch(
        newSession({
          sessionId: "s2",
          title: "t",
          workspaceDirectory: "",
          history: [
            {
              message: { role: "user", content: "Hello", id: "u1" },
              contextItems: [],
            },
          ] as any,
        }),
      );
    });

    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("offers no compaction while a turn runs", async () => {
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
            message: { role: "assistant", content: "Fix", id: "a1" },
            contextItems: [],
          },
        ] as any,
      }),
    );
    const { container, user } = await renderWithProviders(<ContextStatus />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    act(() => {
      store.dispatch(setIsPruned(true));
      store.dispatch(setActive());
    });

    await user.hover(container.querySelector("[data-tooltip-id]")!);
    const link = await screen.findByText("Compact now");
    // The last row is the answer still streaming
    expect(link).toHaveAttribute("aria-disabled", "true");

    act(() => {
      store.dispatch(setInactive());
    });
    expect(link).toHaveAttribute("aria-disabled", "false");
  });
});
