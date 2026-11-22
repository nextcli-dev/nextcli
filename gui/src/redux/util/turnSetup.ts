import { ModelDescription, Tool } from "core";
import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";

import { selectActiveTools } from "../selectors/selectActiveTools";
import type { RootState } from "../store";
import { getBaseSystemMessage } from "./getBaseSystemMessage";

/**
 * The tools and system message a turn with this model is sent with. A turn
 * and a compaction of the conversation both build their request from it.
 */
export function selectTurnSetup(
  state: RootState,
  model: ModelDescription,
): {
  activeTools: Tool[];
  useNativeTools: boolean;
  systemToolsFramework: SystemMessageToolCodeblocksFramework | undefined;
  systemMessage: string | undefined;
} {
  // Get tools and apply model-level overrides (disabled, description, etc.)
  let activeTools = selectActiveTools(state);
  if (model.toolOverrides?.length) {
    const { tools: overriddenTools, errors } = applyToolOverrides(
      activeTools,
      model.toolOverrides,
    );
    activeTools = overriddenTools;
    for (const error of errors) {
      if (!error.fatal) {
        console.warn(`Tool override warning: ${error.message}`);
      }
    }
  }

  // Use the centralized selector to determine if system message tools should be used
  const useNativeTools = state.config.config.experimental
    ?.onlyUseSystemMessageTools
    ? false
    : modelSupportsNativeTools(model);
  const systemToolsFramework = !useNativeTools
    ? new SystemMessageToolCodeblocksFramework()
    : undefined;

  const baseSystemMessage = getBaseSystemMessage(
    state.session.mode,
    model,
    activeTools,
  );
  const systemMessage = systemToolsFramework
    ? addSystemMessageToolsToSystemMessage(
        systemToolsFramework,
        baseSystemMessage,
        activeTools,
      )
    : baseSystemMessage;

  return { activeTools, useNativeTools, systemToolsFramework, systemMessage };
}
