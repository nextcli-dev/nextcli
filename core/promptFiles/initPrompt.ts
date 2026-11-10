import {
  createInitPrompt,
  DEFAULT_PROJECT_AGENT_FILE,
  LEGACY_INIT_RULE_PATH,
} from "@nextcli/config-yaml";
import { IDE, SlashCommandWithSource } from "..";
import { findProjectAgentFile } from "../config/markdown/loadMarkdownRules";
import { BuiltInToolNames } from "../tools/builtIn";
import { getUriPathBasename, joinPathsToUri } from "../util/uri";

/**
 * Builds `/init` for the current workspace. Config reloads whenever an agent
 * file is created, changed or deleted, so the target stays current.
 *
 * The IDE file tools take paths relative to the workspace, so the prompt names
 * files that way rather than by URI.
 */
export async function createInitSlashCommand(
  ide: IDE,
): Promise<SlashCommandWithSource> {
  const existing = await findProjectAgentFile(ide);
  const workspaceDir =
    existing?.workspaceDir ?? (await ide.getWorkspaceDirs())[0];
  const targetPath = existing
    ? getUriPathBasename(existing.uri)
    : DEFAULT_PROJECT_AGENT_FILE;

  let legacyRulePath: string | undefined;
  if (workspaceDir) {
    try {
      const legacyUri = joinPathsToUri(workspaceDir, LEGACY_INIT_RULE_PATH);
      if (await ide.fileExists(legacyUri)) {
        legacyRulePath = LEGACY_INIT_RULE_PATH;
      }
    } catch {
      // No leftover file to retire
    }
  }

  return {
    name: "Init",
    description: existing ? `Update ${targetPath}` : `Create ${targetPath}`,
    source: "built-in",
    prompt: createInitPrompt({
      targetPath,
      targetExists: !!existing,
      directoryLabel: "workspace root",
      tools: {
        read: BuiltInToolNames.ReadFile,
        create: BuiltInToolNames.CreateNewFile,
        edit: BuiltInToolNames.EditExistingFile,
      },
      noWriteToolsHint:
        "/init needs Agent mode to write files. Switch to Agent mode and run /init again.",
      legacyRulePath,
    }),
  };
}
