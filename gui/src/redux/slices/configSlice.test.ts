import { describe, expect, it } from "vitest";
import {
  configSlice,
  EMPTY_CONFIG,
  INITIAL_CONFIG_SLICE,
  missingChatModelError,
  setConfigResult,
  shouldApplyConfigResult,
} from "./configSlice";

const parseError = {
  fatal: true,
  message:
    "Failed to parse config: Implicit keys need to be on a single line\n    at parseConfigYaml",
};

const loadedConfig = {
  ...EMPTY_CONFIG,
  selectedModelByRole: {
    ...EMPTY_CONFIG.selectedModelByRole,
    chat: { title: "Opus 5.5", provider: "openai", model: "claude-opus-5-5" },
  },
} as typeof EMPTY_CONFIG;

describe("shouldApplyConfigResult", () => {
  it("applies a loaded config", () => {
    expect(
      shouldApplyConfigResult({
        config: loadedConfig,
        errors: undefined,
        configLoadInterrupted: false,
      }),
    ).toBe(true);
  });

  it("applies a failed load that has a fatal error", () => {
    expect(
      shouldApplyConfigResult({
        config: undefined,
        errors: [parseError],
        configLoadInterrupted: true,
      }),
    ).toBe(true);
  });

  it("ignores a transient interrupted result without errors", () => {
    expect(
      shouldApplyConfigResult({
        config: undefined,
        errors: undefined,
        configLoadInterrupted: true,
      }),
    ).toBe(false);
  });
});

describe("setConfigResult with a failed load", () => {
  it("drops the stale model and records the error", () => {
    const loaded = configSlice.reducer(
      INITIAL_CONFIG_SLICE,
      setConfigResult({
        config: loadedConfig,
        errors: undefined,
        configLoadInterrupted: false,
      }),
    );
    expect(loaded.config.selectedModelByRole.chat?.title).toBe("Opus 5.5");

    const failed = configSlice.reducer(
      loaded,
      setConfigResult({
        config: undefined,
        errors: [parseError],
        configLoadInterrupted: true,
      }),
    );
    expect(failed.config).toEqual(EMPTY_CONFIG);
    expect(failed.config.selectedModelByRole.chat).toBeNull();
    expect(failed.configError).toEqual([parseError]);
  });
});

describe("missingChatModelError", () => {
  it("names the config failure when there is a fatal error", () => {
    expect(missingChatModelError([parseError]).message).toBe(
      "Config not loaded: Failed to parse config: Implicit keys need to be on a single line",
    );
  });

  it("keeps the original message otherwise", () => {
    expect(missingChatModelError(undefined).message).toBe(
      "No chat model selected",
    );
    expect(
      missingChatModelError([{ fatal: false, message: "warning" }]).message,
    ).toBe("No chat model selected");
  });
});
