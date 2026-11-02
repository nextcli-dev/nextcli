import { describe, expect, it } from "vitest";

import { ILLM } from "..";
import {
  CONFIG_NOT_LOADED_MESSAGE,
  configNotLoadedMessage,
  getSelectedChatModelOrThrow,
} from "./chatModel";

const parseError = {
  fatal: true,
  message:
    "Failed to parse config: Implicit keys need to be on a single line at line 1, column 1:\n\nThe user wants me to apply\n    at parseConfigYaml (unroll.ts:55)",
};

describe("configNotLoadedMessage", () => {
  it("names the first line of the fatal error", () => {
    expect(configNotLoadedMessage([parseError])).toBe(
      "Config not loaded: Failed to parse config: Implicit keys need to be on a single line at line 1, column 1:",
    );
  });

  it("prefers a fatal error over earlier non-fatal ones", () => {
    expect(
      configNotLoadedMessage([
        { fatal: false, message: "warning" },
        { fatal: true, message: "boom" },
      ]),
    ).toBe("Config not loaded: boom");
  });

  it("falls back to the bare message without errors", () => {
    expect(configNotLoadedMessage(undefined)).toBe(CONFIG_NOT_LOADED_MESSAGE);
    expect(configNotLoadedMessage([])).toBe(CONFIG_NOT_LOADED_MESSAGE);
  });
});

describe("getSelectedChatModelOrThrow", () => {
  it("reports a config load failure instead of a missing model", () => {
    expect(() =>
      getSelectedChatModelOrThrow({
        config: undefined,
        errors: [parseError],
        configLoadInterrupted: true,
      }),
    ).toThrow(/^Config not loaded: Failed to parse config/);
  });

  it("reports a missing model when the config loaded without one", () => {
    expect(() =>
      getSelectedChatModelOrThrow({
        config: { selectedModelByRole: { chat: null } } as any,
        errors: [],
        configLoadInterrupted: false,
      }),
    ).toThrow("No chat model selected");
  });

  it("returns the selected chat model", () => {
    const model = { title: "Opus 5.5" } as ILLM;
    expect(
      getSelectedChatModelOrThrow({
        config: { selectedModelByRole: { chat: model } } as any,
        errors: [],
        configLoadInterrupted: false,
      }),
    ).toBe(model);
  });
});
