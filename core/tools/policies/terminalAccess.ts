import {
  isTrustedTerminalCommand,
  ToolPolicy,
  trustedCommandRulesToRemember,
} from "@continuedev/terminal-security";

import { BuiltInToolNames } from "../builtIn";

export interface TerminalCommandTrust {
  /** The trusted rules cover the command (isTrustedTerminalCommand) */
  trusted?: boolean;
  /** Rules that would let the command run without asking next time */
  rememberRules?: string[];
}

/**
 * Whether a Run Terminal Command call is covered by the commands the user
 * trusts, under the tool's policy, and which rules would cover it. Empty for
 * any other tool or a call without a command. The webview turns an ask into
 * a run when `trusted` is set; it never relaxes an excluded tool or a command
 * the evaluator disables. `cwd` is the folder the command runs in
 * (localTerminalDirectory); without it, a `cd` before another command asks.
 */
export function terminalCommandTrust(
  toolName: string,
  parsedArgs: Record<string, unknown>,
  trustedCommands: readonly string[],
  basePolicy: ToolPolicy,
  cwd?: string,
): TerminalCommandTrust {
  const command = parsedArgs.command;
  if (
    toolName !== BuiltInToolNames.RunTerminalCommand ||
    typeof command !== "string"
  ) {
    return {};
  }
  return {
    trusted: isTrustedTerminalCommand(command, trustedCommands, basePolicy, {
      cwd,
    }),
    rememberRules: trustedCommandRulesToRemember(
      command,
      trustedCommands,
      basePolicy,
      { cwd },
    ),
  };
}
