import fs from "fs";

import { rulesToRemember } from "@continuedev/terminal-security";
import YAML from "yaml";

import { logger } from "../util/logger.js";

import { isChainCommandAllowed } from "./permissionChecker.js";
import {
  PERMISSIONS_YAML_PATH,
  PermissionsYamlConfig,
  loadPermissionsYaml,
} from "./permissionsYamlLoader.js";
import { ToolPermissions } from "./types.js";

/**
 * The rules to remember when someone picks "don't ask again" for a call, or
 * undefined when the call can't be remembered safely. A tool other than Bash
 * is remembered whole. A Bash line is remembered one rule per command that
 * `permissions` doesn't allow yet: by its command and subcommand (`npm test`
 * → `Bash(npm test*)`), or exactly when the first argument is an option
 * (`ls -la` → `Bash(ls -la)`), so `npm test` never approves `npm install`. A
 * chain gets a rule for each of its commands (`git add -A && git commit -m x`
 * → `Bash(git add*)`, `Bash(git commit*)`). Nothing is remembered for a line
 * that isn't a plain chain or fails its checks (see rulesToRemember in
 * @continuedev/terminal-security), or that has a wrapper (`env`, `timeout`,
 * `sudo`...), a `NAME=value` prefix, `sh -c` or code that can't be read.
 */
export function generatePolicyRules(
  toolName: string,
  toolArgs: unknown,
  permissions?: ToolPermissions,
): string[] | undefined {
  if (toolName !== "Bash") {
    return [toolName];
  }
  const command = (toolArgs as { command?: unknown } | null | undefined)
    ?.command;
  if (typeof command !== "string") {
    return undefined;
  }
  const rules = rulesToRemember(
    command,
    (member) =>
      permissions !== undefined && isChainCommandAllowed(member, permissions),
    { cwd: process.cwd() },
  );
  return rules?.map((rule) => `Bash(${rule})`);
}

/**
 * Adds allow rules to permissions.yaml in one write, through a temporary file
 * and a rename, so a crash never leaves the file half written
 */
export async function addPoliciesToYaml(policyRules: string[]): Promise<void> {
  try {
    const config: PermissionsYamlConfig = loadPermissionsYaml() || {};
    const allow = config.allow ?? [];
    const added = policyRules.filter((rule) => !allow.includes(rule));
    if (added.length === 0) {
      logger.debug(`Policy rules already exist: ${policyRules.join(", ")}`);
      return;
    }
    config.allow = [...allow, ...added];

    const finalContent = `# NextCLI CLI Permissions Configuration
# This file is managed by the NextCLI CLI and should not be edited manually.
# Use the TUI to modify permissions interactively.

${YAML.stringify(config)}`;

    const temporary = `${PERMISSIONS_YAML_PATH}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temporary, finalContent, "utf-8");
    try {
      await fs.promises.rename(temporary, PERMISSIONS_YAML_PATH);
    } catch (error) {
      await fs.promises.rm(temporary, { force: true });
      throw error;
    }
    logger.info(`Added policy rules to permissions.yaml: ${added.join(", ")}`);
  } catch (error) {
    logger.error("Failed to add policies to permissions.yaml", {
      error,
      policyRules,
    });
    throw error;
  }
}

/**
 * Saves "don't ask again" for a call to permissions.yaml. Returns the rules
 * saved, or undefined when the call can't be remembered (see
 * generatePolicyRules) and was approved once only.
 */
export async function rememberToolApproval(
  toolName: string,
  toolArgs: unknown,
  permissions?: ToolPermissions,
): Promise<string[] | undefined> {
  const policyRules = generatePolicyRules(toolName, toolArgs, permissions);
  if (policyRules) {
    await addPoliciesToYaml(policyRules);
  }
  return policyRules;
}
