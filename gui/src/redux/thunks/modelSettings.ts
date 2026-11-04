import { createAsyncThunk } from "@reduxjs/toolkit";
import type { ModelSettingsPatch } from "core/llm/modelSettings";
import {
  applyModelSettingsPatch,
  modelSettingsKey,
  setModelSettings,
} from "../slices/modelSettingsSlice";
import { clearReasoningSettings } from "../slices/uiSlice";
import { ThunkApiType } from "../store";

/**
 * Loads the model menu settings from core. The first time, it also moves
 * the old lightbulb toggle over: a model with reasoning turned off gets
 * Thinking → Off.
 */
export const loadModelSettings = createAsyncThunk<
  void,
  undefined,
  ThunkApiType
>("modelSettings/load", async (_, { dispatch, extra, getState }) => {
  const response = await extra.ideMessenger.request(
    "modelSettings/getAll",
    undefined,
  );
  if (response.status !== "success") {
    return;
  }
  let all = response.content;

  const legacy = getState().ui.reasoningSettings ?? {};
  const models = getState().config.config.modelsByRole.chat ?? [];
  const migrated: string[] = [];
  for (const [title, enabled] of Object.entries(legacy)) {
    const model = models.find((m) => m.title === title);
    if (!model) continue;
    migrated.push(title);
    const key = modelSettingsKey(model);
    if (
      enabled !== false ||
      all[key]?.stored.thinking !== undefined ||
      !model.controls?.thinkingModes.includes("off")
    ) {
      continue;
    }
    const update = await extra.ideMessenger.request("modelSettings/update", {
      key,
      patch: { thinking: "off" },
    });
    if (update.status === "success") {
      all = update.content;
    }
  }
  if (migrated.length > 0) {
    dispatch(clearReasoningSettings(migrated));
  }
  dispatch(setModelSettings(all));
});

/** Saves a model menu change for one model (shared with the CLI) */
export const updateModelSettings = createAsyncThunk<
  void,
  { key: string; patch: ModelSettingsPatch },
  ThunkApiType
>("modelSettings/update", async ({ key, patch }, { dispatch, extra }) => {
  dispatch(applyModelSettingsPatch({ key, patch }));
  const response = await extra.ideMessenger.request("modelSettings/update", {
    key,
    patch,
  });
  if (response.status === "success") {
    dispatch(setModelSettings(response.content));
  }
});
