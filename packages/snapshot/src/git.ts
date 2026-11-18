import { spawn } from "node:child_process";

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(
      `git ${args[0] ?? ""} failed (exit ${code ?? "signal"}): ${stderr.trim()}`,
    );
    this.name = "GitError";
  }
}

export interface RunGitOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to stdin, then stdin is closed. */
  input?: string | Buffer;
  /** Exit codes that are not failures. Defaults to `[0]`. */
  okCodes?: readonly number[];
}

export interface RunGitResult {
  stdout: Buffer;
  code: number;
}

/**
 * Runs git without a shell. Arguments are never interpolated into a command
 * string, so paths with spaces, quotes or `$` are passed through unchanged.
 */
export function runGit(
  gitBinary: string,
  args: readonly string[],
  options: RunGitOptions,
): Promise<RunGitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const okCodes = options.okCodes ?? [0];
      if (code !== null && okCodes.includes(code)) {
        resolve({ stdout: Buffer.concat(out), code });
      } else {
        reject(new GitError(args, code, Buffer.concat(err).toString("utf8")));
      }
    });
    // A git that exits early (bad object, fatal error) closes stdin first.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

/** The environment without inherited `GIT_*` variables. */
export function cleanEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
  }
  return env;
}

export function splitNul(buffer: Buffer): string[] {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((part) => part.length > 0);
}

export function parseGitVersion(
  output: string,
): [major: number, minor: number] | undefined {
  const match = /git version (\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/**
 * Splits a list of arguments into chunks whose joined length stays under
 * `budget`, so a long file list never hits the command-line limit (about
 * 32 KB on Windows).
 */
export function chunkByLength(
  items: readonly string[],
  budget = 24_000,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const item of items) {
    if (current.length > 0 && length + item.length + 1 > budget) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += item.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
