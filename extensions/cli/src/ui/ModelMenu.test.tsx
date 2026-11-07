import { render } from "ink-testing-library";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

// ink-testing-library writes each frame when React commits it, before React has
// re-registered the menu's key handler. A key sent in that gap reaches the old
// handler, which still holds the previous selection, so it does nothing and
// the menu never moves. Let React flush its effects before every key.
const press = async (stdin: { write: (data: string) => void }, key: string) => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  stdin.write(key);
};

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
      await press(stdin, DOWN);
      await waitFor(() => expect(lastFrame()).toContain(`➤ ${row}`));
    }
    await press(stdin, ENTER);
    await waitFor(() => expect(lastFrame()).toContain("Thinking for Opus"));
    expect(lastFrame()).toContain("(no thinking tokens)");
    // The current mode (Shown) is selected; go up to Off
    await press(stdin, "\u001B[A");
    await waitFor(() => expect(lastFrame()).toContain("➤ Hidden"));
    await press(stdin, "\u001B[A");
    await waitFor(() => expect(lastFrame()).toContain("➤ Off"));
    await press(stdin, ENTER);
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
      await press(stdin, DOWN);
      await waitFor(() => expect(lastFrame()).toContain(`➤ ${row}`));
    }
    await press(stdin, ENTER);
    await waitFor(() => expect(lastFrame()).toContain("always think"));
  });

  it("sets the effort from the submenu", async () => {
    const { stdin, lastFrame } = render(
      <ModelMenu onSelectModel={vi.fn()} onCancel={vi.fn()} />,
    );
    await waitFor(() => expect(lastFrame()).toContain("➤ Model"));
    await press(stdin, DOWN); // Model -> Effort
    await waitFor(() => expect(lastFrame()).toContain("➤ Effort"));
    await press(stdin, ENTER);
    await waitFor(() => expect(lastFrame()).toContain("Effort for Opus"));
    await press(stdin, DOWN); // Default -> Low
    await waitFor(() => expect(lastFrame()).toContain("➤ Low"));
    await press(stdin, ENTER);
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
      await press(stdin, DOWN);
      await waitFor(() => expect(lastFrame()).toContain(`➤ ${row}`));
    }
    await press(stdin, ENTER);
    await waitFor(() => expect(getModelSettings(state.model).fast).toBe(true));
  });
});
