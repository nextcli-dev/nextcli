import fs from "fs";

import { splitCommand } from "@continuedev/terminal-security";
import YAML from "yaml";

import { logger } from "../util/logger.js";

import {
  PERMISSIONS_YAML_PATH,
  PermissionsYamlConfig,
  loadPermissionsYaml,
} from "./permissionsYamlLoader.js";

/**
 * The rule to remember when someone picks "don't ask again" for a call, or
 * undefined when the call can't be remembered safely. A Bash call is
 * remembered by its command name (`ls -la` → `Bash(ls*)`), and only when the
 * line is one plain command: no chain, redirect, substitution, wrapper
 * (`env`, `timeout`, `sudo`...), `NAME=value` prefix, `sh -c` or code that
 * can't be read. Remembering `Bash(sh*)` or `Bash(sudo*)` would allow every
 * command run through them.
 */
export function generatePolicyRule(
  toolName: string,
  toolArgs: any,
): string | undefined {
  if (toolName !== "Bash") {
    return toolName;
  }
  const command = toolArgs?.command;
  if (typeof command !== "string") {
    return undefined;
  }
  const split = splitCommand(command);
  const name = split.commands[0]?.[0];
  if (
    !split.single ||
    split.opaque ||
    split.commands.length !== 1 ||
    !name ||
    /[*?()]/.test(name)
  ) {
    return undefined;
  }
  return `Bash(${name}*)`;
}

/**
 * Adds a policy rule to the permissions.yaml file
 */
export async function addPolicyToYaml(policyRule: string): Promise<void> {
  try {
    // Load existing config or create empty one
    const config: PermissionsYamlConfig = loadPermissionsYaml() || {};

    // Ensure allow array exists
    if (!config.allow) {
      config.allow = [];
    }

    // Add the policy if it doesn't already exist
    if (config.allow.includes(policyRule)) {
      logger.debug(`Policy rule already exists: ${policyRule}`);
    } else {
      config.allow.push(policyRule);

      // Write the updated config back to the file
      const yamlContent = YAML.stringify(config);

      // Add header comment
      const finalContent = `# NextCLI CLI Permissions Configuration
# This file is managed by the NextCLI CLI and should not be edited manually.
# Use the TUI to modify permissions interactively.

${yamlContent}`;

      await fs.promises.writeFile(PERMISSIONS_YAML_PATH, finalContent, "utf-8");
      logger.info(`Added policy rule to permissions.yaml: ${policyRule}`);
    }
  } catch (error) {
    logger.error("Failed to add policy to permissions.yaml", {
      error,
      policyRule,
    });
    throw error;
  }
}

/**
 * Saves "don't ask again" for a call to permissions.yaml. Returns the rule
 * saved, or undefined when the call can't be remembered (see
 * generatePolicyRule) and was approved once only.
 */
export async function rememberToolApproval(
  toolName: string,
  toolArgs: any,
): Promise<string | undefined> {
  const policyRule = generatePolicyRule(toolName, toolArgs);
  if (policyRule) {
    await addPolicyToYaml(policyRule);
  }
  return policyRule;
}
