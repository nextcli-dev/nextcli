import { createInitPrompt } from "@nextcli/config-yaml";
import { SlashCommandWithSource } from "..";

export const initSlashCommand: SlashCommandWithSource = {
  name: "Init",
  description: "Create or update AGENTS.md",
  source: "built-in",
  prompt: createInitPrompt(),
};
