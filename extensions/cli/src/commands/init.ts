import { createInitPrompt } from "@nextcli/config-yaml";

import type { AssistantConfig } from "../services/types.js";
import { SlashCommandResult } from "../ui/hooks/useChat.types.js";

export async function handleInit(
  _args: string[],
  _assistant: AssistantConfig,
): Promise<SlashCommandResult> {
  return {
    newInput: createInitPrompt(),
  };
}
