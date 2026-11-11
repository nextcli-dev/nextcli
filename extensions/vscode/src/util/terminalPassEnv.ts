import type * as vscode from "vscode";

/**
 * The continue.terminalPassEnv setting: secret-like variables the agent's
 * terminal commands keep. Only the user's own settings count. A workspace's
 * .vscode/settings.json comes with the repository, so a malicious repository
 * could otherwise list the keys its prompt injection wants to read. The
 * manifest makes the setting machine-scoped too; this doesn't rely on it.
 */
export function readTerminalPassEnv(
  settings: Pick<vscode.WorkspaceConfiguration, "inspect">,
): string[] {
  const value = settings.inspect<unknown>("terminalPassEnv")?.globalValue;
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : [];
}
