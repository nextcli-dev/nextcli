import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  newSession,
  setActive,
  setContextSnapshot,
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

  it("shows each segment with its count at the end of the row", async () => {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "s",
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
    store.dispatch(
      setContextSnapshot({
        window: 500_000,
        used: 343_200,
        threshold: { tokens: 450_000, action: "pruning", steps: [] },
        segments: [
          { id: "system", label: "System", tokens: 1_700, source: "estimated" },
          { id: "tools", label: "Tools", tokens: 4_200, source: "estimated" },
          {
            id: "history",
            label: "History",
            tokens: 337_300,
            source: "estimated",
          },
        ],
        largestToolResults: [],
      }),
    );
    const { container, user } = await renderWithProviders(<ContextStatus />, {
      store,
      mockIdeMessenger: ideMessenger,
    });

    await user.hover(container.querySelector("[data-tooltip-id]")!);
    expect(await screen.findByText("69% full")).toBeInTheDocument();
    expect(screen.getByText("~343.2K / 500K tokens")).toBeInTheDocument();
    for (const [label, count] of [
      ["System", "1.7K"],
      ["Tools", "4.2K"],
      ["History", "337.3K"],
    ]) {
      const row = screen.getByText(label).parentElement!;
      expect(row.lastElementChild).toHaveTextContent(count);
    }
    expect(screen.getByText("450K")).toBeInTheDocument();
  });

  it("fills the gauge by the share used and empties it without a snapshot", async () => {
    const ideMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "s",
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
    const { container } = await renderWithProviders(<ContextStatus />, {
      store,
      mockIdeMessenger: ideMessenger,
    });
    expect(container.querySelector("svg path")).toBeNull();

    act(() => {
      store.dispatch(
        setContextSnapshot({
          window: 200_000,
          used: 150_000,
          threshold: { tokens: 180_000, action: "pruning", steps: [] },
          segments: [],
          largestToolResults: [],
        }),
      );
    });
    // Three quarters: the wedge takes the large arc
    expect(container.querySelector("svg path")?.getAttribute("d")).toMatch(
      / 0 1 1 /,
    );
    expect(container.querySelector("svg")).toHaveClass("text-description");

    act(() => {
      store.dispatch(setIsPruned(true));
    });
    expect(container.querySelector("svg")).toHaveClass("text-error");

    act(() => {
      store.dispatch(setContextSnapshot(undefined));
    });
    expect(container.querySelector("svg path")).toBeNull();
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
