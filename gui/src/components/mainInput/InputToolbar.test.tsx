import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { newSession } from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import InputToolbar from "./InputToolbar";

describe("InputToolbar", () => {
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

  it("puts the context ring on the right, before Active file", async () => {
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
    const { container } = await renderWithProviders(
      <InputToolbar activeKey={null} />,
      { store, mockIdeMessenger: ideMessenger },
    );

    const ring = container.querySelector('svg[aria-label="Context"]');
    expect(ring).not.toBeNull();
    // Where the old context indicator was: the send-options group, first
    const group = ring!.closest("div")!;
    const activeFile = screen.getByText(/Active file/);
    expect(group.contains(activeFile)).toBe(true);
    expect(
      ring!.compareDocumentPosition(activeFile) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
