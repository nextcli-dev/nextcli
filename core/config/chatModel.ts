import type { ConfigResult } from "@nextcli/config-yaml";

import type { ContinueConfig, ILLM } from "..";

export const CONFIG_NOT_LOADED_MESSAGE = "Config not loaded";

/**
 * Builds the error for a config that failed to load, naming the first fatal
 * error (e.g. a YAML parse error) so the user isn't told that no model is
 * selected when the real problem is the config file.
 */
export function configNotLoadedMessage(
  errors: ConfigResult<unknown>["errors"],
): string {
  const firstError = errors?.find((e) => e.fatal) ?? errors?.[0];
  const detail = firstError?.message?.split("\n")[0]?.trim();
  return detail
    ? `${CONFIG_NOT_LOADED_MESSAGE}: ${detail}`
    : CONFIG_NOT_LOADED_MESSAGE;
}

export function getSelectedChatModelOrThrow(
  result: ConfigResult<ContinueConfig>,
): ILLM {
  if (!result.config) {
    throw new Error(configNotLoadedMessage(result.errors));
  }
  const model = result.config.selectedModelByRole.chat;
  if (!model) {
    throw new Error("No chat model selected");
  }
  return model;
}
