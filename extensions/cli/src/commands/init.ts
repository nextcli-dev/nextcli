import * as fs from "fs";
import * as path from "path";

import {
  createInitPrompt,
  DEFAULT_PROJECT_AGENT_FILE,
  LEGACY_INIT_RULE_PATH,
} from "@nextcli/config-yaml";

import { findProjectAgentFile } from "../projectAgentFile.js";
import type { AssistantConfig } from "../services/types.js";
import { SlashCommandResult } from "../ui/hooks/useChat.types.js";

export async function handleInit(
  _args: string[],
  _assistant: AssistantConfig,
): Promise<SlashCommandResult> {
  // The system message loads the agent file from the working directory, so
  // `/init` resolves and writes it there too.
  const cwd = process.cwd();
  const existing = findProjectAgentFile(cwd);
  const legacyRulePath = path.join(cwd, LEGACY_INIT_RULE_PATH);

  return {
    newInput: createInitPrompt({
      targetPath: existing ?? path.join(cwd, DEFAULT_PROJECT_AGENT_FILE),
      targetExists: !!existing,
      directoryLabel: "working directory",
      tools: { read: "Read", create: "Write", edit: "Edit" },
      noWriteToolsHint:
        "/init needs to write files, and this session is read-only (plan mode). Switch to normal mode, or rerun cn without --readonly, then run /init again.",
      legacyRulePath: fs.existsSync(legacyRulePath)
        ? legacyRulePath
        : undefined,
    }),
  };
}
