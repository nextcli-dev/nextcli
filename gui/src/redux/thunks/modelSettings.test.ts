import type { ModelDescription } from "core";
import { describe, expect, it } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { createMockStore } from "../../util/test/mockStore";
import { updateConfig } from "../slices/configSlice";
import {
  applyModelSettingsPatch,
  modelSettingsKey,
  setModelSettings,
} from "../slices/modelSettingsSlice";
import { buildModelControlOptions } from "./streamNormalInput";
import { loadModelSettings, updateModelSettings } from "./modelSettings";

const OPUS: ModelDescription = {
  title: "Opus 5.5",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  model: "claude-opus-5-5",
  controls: {
    format: "anthropic",
    efforts: ["low", "high"],
    thinkingModes: ["off", "hidden", "shown"],
    thinkingUnavailable: {},
    defaultThinking: "shown",
    canShowThinking: true,
    thinkingNeedsEffort: false,
    effortNeedsThinking: false,
    fast: true,
    experimental: false,
    contextOptions: [200_000, 1_000_000],
    defaultContextLength: 200_000,
  },
};
const KEY = "anthropic/claude-opus-5-5";

describe("buildModelControlOptions", () => {
  it("adds the resolved settings to the request", () => {
    expect(
      buildModelControlOptions(
        { tools: [] },
        {
          key: KEY,
          effort: "high",
          thinking: "off",
          fast: true,
          contextLength: 1_000_000,
          stored: {},
        },
        OPUS,
      ),
    ).toEqual({
      tools: [],
      thinking: "off",
      reasoningEffort: "high",
      fast: true,
      contextLength: 1_000_000,
    });
  });

  it("leaves out defaults and the model's own context window", () => {
    expect(
      buildModelControlOptions(
        {},
        { key: KEY, fast: false, contextLength: 200_000, stored: {} },
        OPUS,
      ),
    ).toEqual({});
    expect(buildModelControlOptions({ tools: [] }, undefined, OPUS)).toEqual({
      tools: [],
    });
  });
});

describe("model settings state", () => {
  it("keys settings like the CLI", () => {
    expect(modelSettingsKey(OPUS)).toBe(KEY);
  });

  it("shows a change before core answers", () => {
    const store = createMockStore();
    store.dispatch(
      setModelSettings({
        [KEY]: { key: KEY, fast: false, contextLength: 200_000, stored: {} },
      }),
    );
    store.dispatch(
      applyModelSettingsPatch({
        key: KEY,
        patch: { fast: true, thinking: "hidden", effort: null },
      }),
    );
    expect((store.getState() as any).modelSettings.byKey[KEY]).toMatchObject({
      fast: true,
      thinking: "hidden",
      stored: { fast: true, thinking: "hidden" },
    });
  });

  it("saves a change through core and keeps its answer", async () => {
    const messenger = new MockIdeMessenger();
    const answer = {
      [KEY]: {
        key: KEY,
        fast: true,
        contextLength: 200_000,
        stored: { fast: true },
      },
    };
    const requests: unknown[] = [];
    messenger.responseHandlers["modelSettings/update"] = async (data) => {
      requests.push(data);
      return answer;
    };
    const store = createMockStore(undefined, messenger);
    await store.dispatch(
      updateModelSettings({ key: KEY, patch: { fast: true } }) as any,
    );
    expect(requests).toEqual([{ key: KEY, patch: { fast: true } }]);
    expect((store.getState() as any).modelSettings.byKey).toEqual(answer);
  });
});

describe("loadModelSettings", () => {
  it("moves the old lightbulb off setting to Thinking → Off once", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responses["modelSettings/getAll"] = {
      [KEY]: { key: KEY, fast: false, contextLength: 200_000, stored: {} },
    };
    const requests: unknown[] = [];
    messenger.responseHandlers["modelSettings/update"] = async (data) => {
      requests.push(data);
      return {
        [KEY]: {
          key: KEY,
          thinking: "off",
          fast: false,
          contextLength: 200_000,
          stored: { thinking: "off" },
        },
      };
    };
    const store = createMockStore(
      {
        ui: {
          ...(createMockStore().getState() as any).ui,
          reasoningSettings: { "Opus 5.5": false, "Removed model": false },
        },
      } as any,
      messenger,
    );
    const config = (store.getState() as any).config.config;
    store.dispatch(
      updateConfig({
        ...config,
        modelsByRole: { ...config.modelsByRole, chat: [OPUS] },
      }),
    );
    await store.dispatch(loadModelSettings() as any);

    expect(requests).toEqual([{ key: KEY, patch: { thinking: "off" } }]);
    const state = store.getState() as any;
    expect(state.modelSettings.byKey[KEY].thinking).toBe("off");
    // Only models in the config are moved; others wait for their profile
    expect(state.ui.reasoningSettings).toEqual({ "Removed model": false });
  });
});

describe("updateModelSettings when saving fails", () => {
  it("restores the previous settings and reports the error", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["modelSettings/update"] = async () => {
      throw new Error("disk full");
    };
    const posts: unknown[] = [];
    messenger.post = ((type: string, data: unknown) => {
      posts.push([type, data]);
    }) as any;
    const store = createMockStore(undefined, messenger);
    const before = {
      [KEY]: { key: KEY, fast: false, contextLength: 200_000, stored: {} },
    };
    store.dispatch(setModelSettings(before));
    await store.dispatch(
      updateModelSettings({ key: KEY, patch: { fast: true } }) as any,
    );
    expect((store.getState() as any).modelSettings.byKey).toEqual(before);
    expect(posts).toContainEqual([
      "showToast",
      ["error", "Couldn't save the model setting: disk full"],
    ]);
  });
});
