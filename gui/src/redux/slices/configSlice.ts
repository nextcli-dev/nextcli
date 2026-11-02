import { ConfigResult, ConfigValidationError } from "@nextcli/config-yaml";
import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { BrowserSerializedContinueConfig } from "core";
import { configNotLoadedMessage } from "core/config/chatModel";
import { DEFAULT_CONTEXT_LENGTH } from "core/llm/constants";

export type ConfigState = {
  configError: ConfigValidationError[] | undefined;
  config: BrowserSerializedContinueConfig;
  loading: boolean;
};

export const EMPTY_CONFIG: BrowserSerializedContinueConfig = {
  slashCommands: [],
  contextProviders: [],
  tools: [],
  mcpServerStatuses: [],
  modelsByRole: {
    chat: [],
    apply: [],
    edit: [],
    summarize: [],
    autocomplete: [],
    rerank: [],
    embed: [],
    subagent: [],
  },
  selectedModelByRole: {
    chat: null,
    apply: null,
    edit: null,
    summarize: null,
    autocomplete: null,
    rerank: null,
    embed: null,
    subagent: null,
  },
  rules: [],
};

export const INITIAL_CONFIG_SLICE: ConfigState = {
  configError: undefined,
  config: EMPTY_CONFIG,
  loading: false,
};

export const configSlice = createSlice({
  name: "config",
  initialState: INITIAL_CONFIG_SLICE,
  reducers: {
    setConfigResult: (
      state,
      {
        payload: result,
      }: PayloadAction<ConfigResult<BrowserSerializedContinueConfig>>,
    ) => {
      const { config, errors } = result;
      if (!errors || errors.length === 0) {
        state.configError = undefined;
      } else {
        state.configError = errors;
      }

      // If an error is found in config on save,
      // We must invalidate the GUI config too,
      // Since core won't be able to load config
      // Don't invalidate the loaded config
      if (!config) {
        state.config = EMPTY_CONFIG;
      } else {
        state.config = config;
      }
      state.loading = false;
    },
    updateConfig: (
      state,
      { payload: config }: PayloadAction<BrowserSerializedContinueConfig>,
    ) => {
      state.config = config;
    },
    setConfigLoading: (state, { payload: loading }: PayloadAction<boolean>) => {
      state.loading = loading;
    },
  },
  selectors: {
    selectSelectedChatModelContextLength: (state): number => {
      return (
        state.config.selectedModelByRole.chat?.contextLength ||
        DEFAULT_CONTEXT_LENGTH
      );
    },
    selectSelectedChatModel: (state) => {
      return state.config.selectedModelByRole.chat;
    },
    selectUIConfig: (state) => {
      return state.config?.ui ?? null;
    },
  },
});

/**
 * Whether a config update from core should replace the GUI config.
 * A result with a config always applies. A result without one applies only
 * when it carries a fatal error (e.g. invalid config.yaml): core then has no
 * models, and keeping the last good config would hide the error behind a
 * stale model selection. Anything else (e.g. no current profile yet) is
 * transient and is ignored.
 */
export function shouldApplyConfigResult(
  result: ConfigResult<BrowserSerializedContinueConfig>,
): boolean {
  return !!result.config || !!result.errors?.some((e) => e.fatal);
}

/**
 * The error to throw when the GUI has no chat model. When the config failed
 * to load, name that failure instead of blaming the model selection.
 */
export function missingChatModelError(
  configError: ConfigValidationError[] | undefined,
): Error {
  if (configError?.some((e) => e.fatal)) {
    return new Error(configNotLoadedMessage(configError));
  }
  return new Error("No chat model selected");
}

export const { updateConfig, setConfigResult, setConfigLoading } =
  configSlice.actions;

export const {
  selectSelectedChatModelContextLength,
  selectUIConfig,
  selectSelectedChatModel,
} = configSlice.selectors;

export default configSlice.reducer;
