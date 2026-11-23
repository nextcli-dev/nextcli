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

  it("puts the context ring in the same group as the attach-context icon", async () => {
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
    const onAddContextItem = vi.fn();
    const { container, user } = await renderWithProviders(
      <InputToolbar activeKey={null} onAddContextItem={onAddContextItem} />,
      { store, mockIdeMessenger: ideMessenger },
    );

    const ring = container.querySelector('svg[aria-label="Context"]');
    expect(ring).not.toBeNull();
    // With no image support, the only other icon in the ring's group is
    // attach context: clicking it must open the context menu
    const group = ring!.closest("div")!;
    const others = [...group.querySelectorAll("svg")].filter(
      (svg) => svg !== ring,
    );
    expect(others).toHaveLength(1);
    await user.click(others[0]);
    expect(onAddContextItem).toHaveBeenCalledTimes(1);
  });
});
