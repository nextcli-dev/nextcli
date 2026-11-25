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
 * runs. `keep` names variables to leave alone (--pass-env). A chain starting
 * with `cd` is approved for a subdirectory of `cwd` (commandChain.ts), so the
 * command also starts in `cwd`, the folder the process is spawned in, even if
 * the profile changed folder, and without the profile's CDPATH, which would
 * send `cd sub` to another project's `sub`.
 */
export function secureShellCommand(
  command: string,
  keep: readonly string[],
  {
    cwd,
    platform = process.platform,
    shell = process.env.SHELL,
  }: { cwd: string; platform?: NodeJS.Platform; shell?: string },
): { shell: string; args: string[] } {
  if (platform === "win32") {
    // PowerShell also reads typographic single quotes as quotes
    const folder = `'${cwd.replace(/['‘’‚‛]/g, "$&$&")}'`;
    return {
      shell: "powershell.exe",
      args: [
        "-NoLogo",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `${powershellUnsetPrelude(keep)}; Set-Location -LiteralPath ${folder} -ErrorAction Stop; ${command}`,
      ],
    };
  }
  const folder = `'${cwd.replace(/'/g, "'\\''")}'`;
  return {
    shell: posixShell(shell),
    args: [
      "-l",
      "-c",
      `${posixUnsetPrelude(keep)}\nunset CDPATH\ncd -- ${folder} || exit 1\n${command}`,
    ],
  };
}
