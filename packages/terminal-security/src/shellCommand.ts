import fs from "node:fs";
import path from "node:path";

import { posixUnsetPrelude, powershellUnsetPrelude } from "./secretEnv.js";

// Shells that can run the POSIX prelude
const POSIX_SHELLS = new Set([
  "bash",
  "zsh",
  "sh",
  "dash",
  "ksh",
  "mksh",
  "ash",
]);

/**
 * The user's shell, or bash (else sh) when it isn't a POSIX shell, such as
 * fish
 */
function posixShell(userShell: string | undefined): string {
  if (userShell && POSIX_SHELLS.has(path.basename(userShell))) {
    return userShell;
  }
  return fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/**
 * How to run a command the model wrote: a login shell on Unix, macOS and WSL,
 * so the profile sets up PATH, and PowerShell on Windows. The profile can
 * export secret-like variables that the caller already removed from the
 * environment, so a prelude removes them inside the shell before the command
 * runs. `keep` names variables to leave alone (--pass-env).
 */
export function secureShellCommand(
  command: string,
  keep: readonly string[] = [],
  { platform = process.platform, shell = process.env.SHELL } = {},
): { shell: string; args: string[] } {
  if (platform === "win32") {
    return {
      shell: "powershell.exe",
      args: [
        "-NoLogo",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `${powershellUnsetPrelude(keep)}; ${command}`,
      ],
    };
  }
  return {
    shell: posixShell(shell),
    args: ["-l", "-c", `${posixUnsetPrelude(keep)}\n${command}`],
  };
}
