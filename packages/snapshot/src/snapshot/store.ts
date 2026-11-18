import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { StoreLock } from "../git/lock.js";
import {
  chunkByLength,
  runGit,
  splitNul,
  type RunGitResult,
} from "../git/runGit.js";

export const EMPTY_GITCONFIG = "nextcli-empty.gitconfig";
const HOOKS_DIR = "nextcli-hooks";
const LOCK_FILE = "nextcli.lock";

export interface ShadowRepoConfig {
  gitBinary: string;
  baseEnv: NodeJS.ProcessEnv;
  toplevel: string;
  projectGitDir: string;
  projectCommonDir: string;
  storeRoot: string;
  storeDir: string;
  /** Set when the store lives inside the work tree. */
  storeRel?: string;
  maxUntrackedFileBytes: number;
}

export interface TreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

export function storeKey(toplevel: string): string {
  return createHash("sha256").update(toplevel).digest("hex").slice(0, 32);
}

/**
 * A git store whose work tree is the project; it records trees only. No
 * global or system config, so no filter, hook or fsmonitor command runs.
 */
export class ShadowRepo {
  readonly toplevel: string;
  readonly storeDir: string;
  readonly lock: StoreLock;
  readonly env: NodeJS.ProcessEnv;

  constructor(readonly config: ShadowRepoConfig) {
    this.toplevel = config.toplevel;
    this.storeDir = config.storeDir;
    this.lock = new StoreLock(path.join(config.storeDir, LOCK_FILE));
    this.env = {
      ...config.baseEnv,
      GIT_DIR: config.storeDir,
      GIT_WORK_TREE: config.toplevel,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(config.storeDir, EMPTY_GITCONFIG),
      GIT_LITERAL_PATHSPECS: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  /** Locked: two processes opening one store would race on `git init`. */
  async init(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true });
    await this.lock.run(() => this.initUnlocked());
  }

  private async initUnlocked(): Promise<void> {
    const { storeDir } = this.config;
    await fs.mkdir(path.join(storeDir, HOOKS_DIR), { recursive: true });
    await fs.writeFile(path.join(storeDir, EMPTY_GITCONFIG), "");
    const initialised = await fs.stat(path.join(storeDir, "HEAD")).then(
      () => true,
      () => false,
    );
    if (!initialised) {
      await this.git(["init", "--quiet"]);
      const settings: [string, string][] = [
        ["core.bare", "false"],
        ["core.autocrlf", "false"],
        ["core.longpaths", "true"],
        ["core.symlinks", "true"],
        ["core.fsmonitor", "false"],
        ["core.quotepath", "false"],
        ["core.logAllRefUpdates", "false"],
        ["core.hooksPath", path.join(storeDir, HOOKS_DIR)],
        ["gc.auto", "0"],
      ];
      for (const [key, value] of settings) {
        await this.git(["config", key, value]);
      }
    }
    // Reuse the project's objects; restore checks they still exist
    await fs.mkdir(path.join(storeDir, "objects", "info"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(storeDir, "objects", "info", "alternates"),
      path.join(this.config.projectCommonDir, "objects") + "\n",
    );
  }

  git(
    args: string[],
    options: {
      input?: string;
      okCodes?: number[];
      env?: NodeJS.ProcessEnv;
    } = {},
  ): Promise<RunGitResult> {
    return runGit(this.config.gitBinary, args, {
      env: this.env,
      cwd: this.toplevel,
      ...options,
    });
  }

  async changedFiles(from: string, to: string): Promise<string[]> {
    if (from === to) return [];
    const { stdout } = await this.git([
      "diff-tree",
      "-r",
      "-z",
      "--name-only",
      "--no-renames",
      from,
      to,
    ]);
    return splitNul(stdout);
  }

  /** Paths must have real parent folders: git refuses one beyond a symlink. */
  async ignored(files: readonly string[]): Promise<Set<string>> {
    if (files.length === 0) return new Set();
    // Exit 1: none ignored. check-ignore rejects literal pathspecs.
    const { GIT_LITERAL_PATHSPECS: _literal, ...env } = this.env;
    const { stdout } = await this.git(
      ["check-ignore", "--no-index", "-z", "--stdin"],
      { env, input: files.join("\0") + "\0", okCodes: [0, 1] },
    );
    return new Set(splitNul(stdout));
  }

  async lsTree(
    tree: string,
    files: readonly string[],
  ): Promise<Map<string, TreeEntry>> {
    const entries = new Map<string, TreeEntry>();
    for (const chunk of chunkByLength(files)) {
      // Must throw: "not in the tree" would make undo delete the file
      const { stdout } = await this.git([
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        tree,
        "--",
        ...chunk,
      ]);
      for (const line of splitNul(stdout)) {
        const tab = line.indexOf("\t");
        const [mode, type, object] = line.slice(0, tab).split(" ");
        const file = line.slice(tab + 1);
        if (mode && type && object) {
          entries.set(file, { mode, type, object, path: file });
        }
      }
    }
    return entries;
  }
}
