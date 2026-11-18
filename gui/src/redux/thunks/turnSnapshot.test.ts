import type { ChatHistoryItem } from "core";
import { describe, expect, it } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { RootState } from "../store";
import {
  applyRedo,
  applyUndo,
  beginTurnSnapshot,
  finishTurnSnapshotIfDone,
  isTurnOver,
  lastUndoableIndex,
  planUndo,
} from "./turnSnapshot";

const ROOT = "/repo";

function item(
  role: "user" | "assistant",
  content: string,
  extra: Partial<ChatHistoryItem> = {},
): any {
  return {
    message: { role, content, id: `${role}-${content}` },
    contextItems: [],
    ...extra,
  };
}

function api(store: ReturnType<typeof storeWith>): any {
  return {
    dispatch: store.dispatch,
    getState: store.getState,
    extra: { ideMessenger: store.mockIdeMessenger },
  };
}

function storeWith(
  history: any[],
  session: Partial<RootState["session"]> = {},
) {
  const base = getEmptyRootState();
  return createMockStore({
    session: { ...base.session, history, ...session },
  });
}

const plan = {
  roots: [
    {
      root: ROOT,
      plan: {
        targets: [
          { path: "a.ts", tree: "start" },
          { path: "new.ts", tree: "start" },
        ],
        restore: ["a.ts"],
        delete: ["new.ts"],
        conflicts: [],
      },
    },
  ],
};

describe("isTurnOver", () => {
  it("is false while streaming, a tool waits or an edit is open", () => {
    const history = [item("user", "go"), item("assistant", "ok")];
    expect(isTurnOver(storeWith(history).getState() as RootState)).toBe(true);
    expect(
      isTurnOver(
        storeWith(history, { isStreaming: true }).getState() as RootState,
      ),
    ).toBe(false);

    const waiting = [
      item("user", "go"),
      item("assistant", "", {
        toolCallStates: [{ status: "generated", toolCallId: "t" } as any],
      }),
    ];
    expect(isTurnOver(storeWith(waiting).getState() as RootState)).toBe(false);

    const applying = storeWith(history, {
      codeBlockApplyStates: {
        states: [{ streamId: "s", status: "done" }],
        curIndex: 0,
      },
    });
    expect(isTurnOver(applying.getState() as RootState)).toBe(false);
  });
});

describe("turn snapshots", () => {
  it("stores the start on the user message, then the end once the turn is over", async () => {
    const store = storeWith([item("user", "go"), item("assistant", "")], {
      codeBlockApplyStates: {
        states: [
          { streamId: "s", status: "closed", filepath: "file:///repo/a.ts" },
        ],
        curIndex: 0,
      },
    });
    const messenger = store.mockIdeMessenger;
    messenger.responses["snapshot/capture"] = {
      roots: [{ root: ROOT, tree: "start" }],
    };
    messenger.responses["snapshot/syncDocuments"] = undefined;
    messenger.responseHandlers["snapshot/finishTurn"] = async ({
      checkpoint,
    }: any) => ({
      v: 1,
      roots: checkpoint.roots.map((r: any) => ({
        ...r,
        end: "end",
        files: ["a.ts"],
      })),
    });

    await beginTurnSnapshot(api(store), 0);
    expect(
      (store.getState() as RootState).session.history[0].checkpoint,
    ).toEqual({
      v: 1,
      roots: [{ root: ROOT, start: "start" }],
    });
    expect(
      lastUndoableIndex((store.getState() as RootState).session.history),
    ).toBe(0);

    expect(await finishTurnSnapshotIfDone(api(store))).toBe(true);
    expect(
      (store.getState() as RootState).session.history[0].checkpoint!.roots[0],
    ).toEqual({
      root: ROOT,
      start: "start",
      end: "end",
      files: ["a.ts"],
    });
  });

  it("doesn't store an end while the turn is still running", async () => {
    const checkpoint = { v: 1, roots: [{ root: ROOT, start: "start" }] };
    const store = storeWith([item("user", "go", { checkpoint } as any)], {
      isStreaming: true,
    });
    expect(await finishTurnSnapshotIfDone(api(store))).toBe(false);
  });

  it("never fails the turn when snapshots are unavailable", async () => {
    const store = storeWith([item("user", "go")]);
    delete store.mockIdeMessenger.responses["snapshot/capture"];
    await beginTurnSnapshot(api(store), 0);
    expect(
      (store.getState() as RootState).session.history[0].checkpoint,
    ).toBeUndefined();
  });
});

describe("undo and redo", () => {
  const checkpoint = {
    v: 1,
    roots: [{ root: ROOT, start: "start", end: "end", files: ["a.ts"] }],
  };
  const history = [
    item("user", "first"),
    item("assistant", "one"),
    item("user", "second", { checkpoint } as any),
    item("assistant", "two"),
  ];

  function undoStore() {
    const store = storeWith(history);
    const messenger = store.mockIdeMessenger;
    messenger.responses["history/save"] = undefined;
    messenger.responses["snapshot/syncDocuments"] = undefined;
    messenger.responses["snapshot/planRevert"] = plan;
    messenger.responseHandlers["snapshot/restore"] = async ({
      roots,
    }: any) => ({
      roots: roots.map((r: any) => ({
        root: r.root,
        result: {
          restored: ["a.ts"],
          deleted: ["new.ts"],
          keptIgnored: [],
          skipped: [],
          redoTree: "redo",
        },
      })),
    });
    return store;
  }

  it("removes the undone turns and puts them back on redo", async () => {
    const store = undoStore();
    const planned: any = await store.dispatch(
      planUndo({ fromIndex: 2 }) as any,
    );
    expect(planned.payload).toMatchObject({ fromIndex: 2, turns: 1 });

    await store.dispatch(
      applyUndo({
        plan: planned.payload,
        mode: "code-and-conversation",
      }) as any,
    );
    let session = (store.getState() as RootState).session;
    expect(session.history).toHaveLength(2);
    expect(session.undoneTurn).toEqual({
      roots: [
        {
          root: ROOT,
          targets: [
            { path: "a.ts", tree: "redo" },
            { path: "new.ts", tree: "redo" },
          ],
        },
      ],
      removedHistory: history.slice(2),
    });

    await store.dispatch(applyRedo() as any);
    session = (store.getState() as RootState).session;
    expect(session.history).toEqual(history);
    expect(session.undoneTurn).toBeUndefined();
  });

  it("keeps the conversation when restoring code only", async () => {
    const store = undoStore();
    const planned: any = await store.dispatch(
      planUndo({ fromIndex: 2 }) as any,
    );
    await store.dispatch(
      applyUndo({ plan: planned.payload, mode: "code" }) as any,
    );
    expect((store.getState() as RootState).session.history).toHaveLength(4);
    expect(
      (store.getState() as RootState).session.undoneTurn?.removedHistory,
    ).toBeUndefined();
  });

  it("refuses to plan for a message without a snapshot", async () => {
    const store = undoStore();
    const action: any = await store.dispatch(planUndo({ fromIndex: 4 }) as any);
    expect(action.error.message).toMatch(/no snapshot/);
  });
});
