import { render } from "ink-testing-library";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleEffort } from "../slashCommands.js";
import {
  getModelSettings,
  resetModelSettingsCache,
  updateModelSettings,
} from "../util/modelSettings.js";

import { ModelMenu } from "./ModelMenu.js";

const state = vi.hoisted(() => ({
  model: {
    name: "Opus",
    provider: "anthropic",
    model: "claude-opus-5-5",
  } as any,
}));

vi.mock("../services/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/index.js")>()),
  services: {
    model: {
      getState: () => ({ model: state.model }),
      getAvailableChatModels: () => [],
      getCurrentModelIndex: () => 0,
    },
  },
}));

// Generous timeout: ink renders slowly when the whole suite runs in parallel
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 5000 });

const DOWN = "\u001B[B";
const ENTER = "\r";

describe("ModelMenu", () => {
  beforeEach(() => {
    state.model = {
      name: "Opus",
      provider: "anthropic",
      model: "claude-opus-5-5",
    };
    resetModelSettingsCache();
    updateModelSettings(state.model, {
      effort: undefined,
      fast: undefined,
      showThinking: undefined,
      thinking: undefined,
    });
  });

  it("shows the model and the settings it supports", () => {
    const { lastFrame } = render(
      <ModelMenu onSelectModel={vi.fn()} onCancel={vi.fn()} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Model settings (experimental)");
    expect(frame).toContain("Opus");
    expect(frame).toContain("Effort");
    expect(frame).toContain("Thinking");
    expect(frame).toContain("Fast");
    expect(frame).toContain("Context");
  });

  it("hides settings the model doesn't have", () => {
    state.model = { name: "GPT", provider: "openai", model: "gpt-4.1" };
    const { lastFrame } = render(
      <ModelMenu onSelectModel={vi.fn()} onCancel={vi.fn()} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Effort");
    expect(frame).not.toContain("Thinking");
  });

  it("shows thinking off for Claude 4.6 to 4.8 until an effort is set", () => {
    state.model = {
      name: "Sonnet",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    };
    updateModelSettings(state.model, {
      effort: undefined,
      thinking: undefined,
    });
    const { lastFrame } = render(
      <ModelMenu onSelectModel={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(lastFrame()).toMatch(/Thinking\s+Off/);
    updateModelSettings(state.model, { effort: "high" });
    const { lastFrame: withEffort } = render(
      <ModelMenu onSelectModel={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(withEffort()).toMatch(/Thinking\s+Shown/);
  });

  it("sets the thinking mode from the submenu", async () => {
    // Sonnet 5.5 can turn thinking off; Opus 5.5 can't
    state.model = {
      name: "Opus",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    };
    const { stdin, lastFrame } = render(
      <ModelMenu onSelectModel={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(lastFrame()).toContain("➤ Model"));
    for (const row of ["Effort", "Thinking"]) {
      stdin.write(DOWN);
      await waitFor(() => expect(lastFrame()).toContain(`➤ ${row}`));
    }
    stdin.write(ENTER);
    await waitFor(() => expect(lastFrame()).toContain("Thinking for Opus"));
    expect(lastFrame()).toContain("(no thinking tokens)");
    // The current mode (Shown) is selected; go up to Off
    stdin.write("\u001B[A");
    await waitFor(() => expect(lastFrame()).toContain("➤ Hidden"));
    stdin.write("\u001B[A");
    await waitFor(() => expect(lastFrame()).toContain("➤ Off"));
    stdin.write(ENTER);
    await waitFor(() =>
      expect(getModelSettings(state.model).thinking).toBe("off"),
    );
  });

  it("says why a thinking mode is missing", async () => {
    state.model = {
      name: "Gemini",
      provider: "gemini",
      model: "gemini-3.1-pro",
    };
    const { stdin, lastFrame } = render(
      <ModelMenu onSelectModel={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(lastFrame()).toContain("➤ Model"));
    for (const row of ["Effort", "Thinking"]) {
      stdin.write(DOWN);
      await waitFor(() => expect(lastFrame()).toContain(`➤ ${row}`));
    }
    stdin.write(ENTER);
    await waitFor(() => expect(lastFrame()).toContain("always think"));
  });

  it("sets the effort from the submenu", async () => {
    const { stdin, lastFrame } = render(
      <ModelMenu onSelectModel={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(lastFrame()).toContain("➤ Model"));
    stdin.write(DOWN); // Model -> Effort
    await waitFor(() => expect(lastFrame()).toContain("➤ Effort"));
    stdin.write(ENTER);
    await waitFor(() => expect(lastFrame()).toContain("Effort for Opus"));
    stdin.write(DOWN); // Default -> Low
    await waitFor(() => expect(lastFrame()).toContain("➤ Low"));
    stdin.write(ENTER);
    await waitFor(() =>
      expect(getModelSettings(state.model).effort).toBe("low"),
    );
    await waitFor(() =>
      expect(lastFrame()).toContain("Model settings (experimental)"),
    );
  });

  it("toggles fast mode", async () => {
    const { stdin, lastFrame } = render(
      <ModelMenu onSelectModel={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(lastFrame()).toContain("➤ Model"));
    for (const row of ["Effort", "Thinking", "Fast"]) {
      stdin.write(DOWN);
      await waitFor(() => expect(lastFrame()).toContain(`➤ ${row}`));
    }
    stdin.write(ENTER);
    await waitFor(() => expect(getModelSettings(state.model).fast).toBe(true));
  });
});

describe("/effort", () => {
  beforeEach(() => {
    state.model = {
      name: "Opus",
      provider: "anthropic",
      model: "claude-opus-5-5",
    };
    resetModelSettingsCache();
    updateModelSettings(state.model, { effort: undefined });
  });

  it("shows the current effort and the levels", () => {
    expect(handleEffort([]).output).toBe(
      "Effort for Opus: Default. Levels: default, low, medium, high, xhigh, max.",
    );
  });

  it("sets and clears the effort", () => {
    expect(handleEffort(["HIGH"]).output).toBe("Effort for Opus set to High.");
    expect(getModelSettings(state.model).effort).toBe("high");
    handleEffort(["default"]);
    expect(getModelSettings(state.model).effort).toBeUndefined();
  });

  it("turns thinking off for models without effort levels (DeepSeek)", () => {
    state.model = {
      name: "DeepSeek",
      provider: "deepseek",
      model: "deepseek-v4-pro",
    };
    updateModelSettings(state.model, {
      thinking: undefined,
      effort: undefined,
    });
    expect(handleEffort(["off"]).output).toBe(
      "Thinking for DeepSeek turned off.",
    );
    expect(getModelSettings(state.model).thinking).toBe("off");
    expect(handleEffort([]).output).toBe("DeepSeek has no effort levels.");
  });

  it("rejects levels the model doesn't have", () => {
    state.model = {
      name: "Haiku",
      provider: "anthropic",
      model: "claude-haiku-4-5",
    };
    expect(handleEffort(["max"]).output).toBe(
      'Unknown effort "max". Levels: default, low, medium, high.',
    );
  });
});
