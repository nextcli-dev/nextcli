import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import type { ModelDescription } from "core";
import type {
  ModelSettingsPatch,
  ResolvedModelSettings,
} from "core/llm/modelSettings";

/**
 * Model menu settings (effort, thinking, fast, context) per model, as
 * resolved by core. They're saved on the host and shared with the CLI, so
 * they aren't persisted here.
 */
export interface ModelSettingsState {
  byKey: Record<string, ResolvedModelSettings>;
}

const initialState: ModelSettingsState = {
  byKey: {},
};

/** The key core stores settings under: `provider/model`, as in the CLI */
export function modelSettingsKey(
  model: Pick<ModelDescription, "provider" | "model">,
): string {
  return `${model.provider}/${model.model}`;
}

export const modelSettingsSlice = createSlice({
  name: "modelSettings",
  initialState,
  reducers: {
    setModelSettings: (
      state,
      { payload }: PayloadAction<Record<string, ResolvedModelSettings>>,
    ) => {
      state.byKey = payload;
    },
    /** Shows a change right away, before core returns the resolved settings */
    applyModelSettingsPatch: (
      state,
      { payload }: PayloadAction<{ key: string; patch: ModelSettingsPatch }>,
    ) => {
      const current = state.byKey[payload.key];
      if (!current) return;
      const { patch } = payload;
      if (patch.thinking) current.thinking = patch.thinking;
      if (patch.effort !== undefined) {
        current.effort = patch.effort ?? undefined;
      }
      if (patch.fast !== undefined) current.fast = !!patch.fast;
      if (patch.contextLength) current.contextLength = patch.contextLength;
      for (const [name, value] of Object.entries(patch)) {
        if (value === null) {
          delete (current.stored as Record<string, unknown>)[name];
        } else if (value !== undefined) {
          (current.stored as Record<string, unknown>)[name] = value;
        }
      }
    },
  },
  selectors: {
    selectModelSettings: (
      state,
      model: ModelDescription | null | undefined,
    ): ResolvedModelSettings | undefined =>
      model ? state.byKey[modelSettingsKey(model)] : undefined,
  },
});

export const { setModelSettings, applyModelSettingsPatch } =
  modelSettingsSlice.actions;
export const { selectModelSettings } = modelSettingsSlice.selectors;

export default modelSettingsSlice.reducer;
