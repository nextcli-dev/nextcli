import {
  ConfigValidationError,
  markdownToRule,
  PROJECT_AGENT_FILE_NAMES,
} from "@nextcli/config-yaml";
import { IDE, RuleWithSource } from "../..";
import { PROMPTS_DIR_NAME, RULES_DIR_NAME } from "../../promptFiles";
import { joinPathsToUri } from "../../util/uri";
import { getAllDotContinueDefinitionFiles } from "../loadLocalAssistants";

export const SUPPORTED_AGENT_FILES: readonly string[] =
  PROJECT_AGENT_FILE_NAMES;

export interface ProjectAgentFileLocation {
  uri: string;
  workspaceDir: string;
}

/**
 * Finds the project agent file: the first workspace that has any of
 * SUPPORTED_AGENT_FILES at its root, and the first name in that workspace.
 * Decided by existence only, so the loader and `/init` agree on the file.
 */
export async function findProjectAgentFile(
  ide: IDE,
): Promise<ProjectAgentFileLocation | undefined> {
  const workspaceDirs = await ide.getWorkspaceDirs();
  for (const workspaceDir of workspaceDirs) {
    for (const fileName of SUPPORTED_AGENT_FILES) {
      const uri = joinPathsToUri(workspaceDir, fileName);
      try {
        if (await ide.fileExists(uri)) {
          return { uri, workspaceDir };
        }
      } catch {
        // Treat a failed existence check as "not there"
      }
    }
  }
  return undefined;
}

/**
 * Loads rules from markdown files in the .continue/rules and .continue/prompts directories
 * and the project agent file (see findProjectAgentFile)
 */
export async function loadMarkdownRules(ide: IDE): Promise<{
  rules: RuleWithSource[];
  errors: ConfigValidationError[];
}> {
  const errors: ConfigValidationError[] = [];
  const rules: RuleWithSource[] = [];

  const agentFile = await findProjectAgentFile(ide);
  if (agentFile) {
    // No fallback to a lower-priority name: `/init` writes this file, so
    // loading another one would hide it.
    try {
      const agentContent = await ide.readFile(agentFile.uri);
      const rule = markdownToRule(agentContent, {
        uriType: "file",
        fileUri: agentFile.uri,
      });
      rules.push({
        ...rule,
        source: "agentFile",
        sourceFile: agentFile.uri,
        alwaysApply: true,
      });
    } catch (e) {
      errors.push({
        fatal: false,
        message: `Failed to load agent file ${agentFile.uri}: ${e instanceof Error ? e.message : e}`,
      });
    }
  }

  // Load markdown files from both .continue/rules and .continue/prompts
  const dirsToCheck = [RULES_DIR_NAME, PROMPTS_DIR_NAME];

  for (const dirName of dirsToCheck) {
    try {
      const markdownFiles = await getAllDotContinueDefinitionFiles(
        ide,
        {
          includeGlobal: true,
          includeWorkspace: true,
          fileExtType: "markdown",
        },
        dirName,
      );

      // Filter to just .md files
      const mdFiles = markdownFiles.filter((file) => file.path.endsWith(".md"));

      // Process each markdown file
      for (const file of mdFiles) {
        try {
          const rule = markdownToRule(file.content, {
            uriType: "file",
            fileUri: file.path,
          });
          if (!rule.invokable) {
            rules.push({
              ...rule,
              source: "rules-block",
              sourceFile: file.path,
            });
          }
        } catch (e) {
          errors.push({
            fatal: false,
            message: `Failed to parse markdown rule file ${file.path}: ${e instanceof Error ? e.message : e}`,
          });
        }
      }
    } catch (e) {
      errors.push({
        fatal: false,
        message: `Error loading markdown rule files from ${dirName}: ${e instanceof Error ? e.message : e}`,
      });
    }
  }

  return { rules, errors };
}
