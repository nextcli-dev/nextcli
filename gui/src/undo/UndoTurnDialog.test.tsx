import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  newSession,
  setActive,
  setInactive,
} from "../redux/slices/sessionSlice";
import { MockIdeMessenger } from "../context/MockIdeMessenger";
import { setupStore } from "../redux/store";
import { renderWithProviders } from "../util/test/render";
import { UndoTurnDialog } from "./UndoTurnDialog";

const checkpoint = {
  v: 1 as const,
  roots: [{ root: "/repo", start: "start", end: "end", files: ["a.ts"] }],
};

const plan = {
  roots: [
    {
      root: "/repo",
      plan: {
        targets: [{ path: "a.ts", tree: "start" }],
        restore: ["a.ts"],
        delete: [],
        conflicts: [],
        skipped: [],
      },
    },
  ],
};

describe("UndoTurnDialog", () => {
  it("can't restore while a turn runs, and can once it is over", async () => {
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responses["snapshot/planRevert"] = plan;
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "s",
        title: "t",
        workspaceDirectory: "",
        history: [
          {
            message: { role: "user", content: "go", id: "u" },
            contextItems: [],
            checkpoint,
          },
          {
            message: { role: "assistant", content: "done", id: "a" },
            contextItems: [],
          },
        ] as any,
      }),
    );
    await renderWithProviders(<UndoTurnDialog fromIndex={0} />, {
      store,
      mockIdeMessenger: ideMessenger,
    });

    const restore = await screen.findByText("Restore code only");
    await waitFor(() => expect(restore).toBeEnabled());

    await act(async () => {
      store.dispatch(setActive());
    });
    expect(restore).toBeDisabled();

    await act(async () => {
      store.dispatch(setInactive());
    });
    expect(restore).toBeEnabled();
  });
});
