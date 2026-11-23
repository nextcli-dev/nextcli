import type { ModelDescription } from "core";
import { describe, expect, it } from "vitest";

import { getEmptyRootState } from "../../util/test/mockStore";
import type { RootState } from "../store";
import { selectContextMeasure } from "./selectContextMeasure";

const model = (title: string) =>
  ({ title, model: "same-model-id", provider: "openai" }) as ModelDescription;

const snapshot = {
  window: 32_000,
  used: 30_000,
  threshold: { tokens: 28_000, action: "pruning" as const, steps: [] },
  segments: [],
  largestToolResults: [],
};

/** A measure taken for "Small window" in agent mode */
function stateWith(chatTitle: string, mode: RootState["session"]["mode"]) {
  const state = getEmptyRootState();
  return {
    ...state,
    config: {
      ...state.config,
      config: {
        ...state.config.config,
        selectedModelByRole: {
          ...state.config.config.selectedModelByRole,
          chat: model(chatTitle),
        },
      },
    },
    session: {
      ...state.session,
      mode,
      isPruned: true,
      contextPercentage: 1.07,
      contextSnapshot: snapshot,
      contextMeasuredFor: { model: "Small window", mode: "agent" as const },
    },
  } as RootState;
}

describe("selectContextMeasure", () => {
  it("returns the measure for the model and mode it was taken for", () => {
    expect(selectContextMeasure(stateWith("Small window", "agent"))).toEqual({
      snapshot,
      contextPercentage: 1.07,
      isPruned: true,
    });
  });

  it("returns nothing after a switch to another model with the same id", () => {
    expect(selectContextMeasure(stateWith("Large window", "agent"))).toEqual({
      snapshot: undefined,
      contextPercentage: undefined,
      isPruned: false,
    });
  });

  it("returns nothing in another mode, which sends other tools and prompt", () => {
    expect(
      selectContextMeasure(stateWith("Small window", "chat")).snapshot,
    ).toBeUndefined();
  });
});
