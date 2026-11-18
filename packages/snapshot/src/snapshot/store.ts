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
  /**
   * The store root relative to the work tree, with `/` separators, when the
   * store lives inside it. Captures leave it out and undo never touches it.
   */
  storeRel?: string;
  maxUntrackedFileBytes: number;
}

export interface TreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

/** Name of the store directory for a work tree. */
export function storeKey(toplevel: string): string {
  return createHash("sha256").update(toplevel).digest("hex").slice(0, 32);
}

/**
 * The shadow git repository: a store under the store root whose work tree is
 * the project. It records trees (no commits, no branches) and never touches
 * the project's own `.git`.
 *
 * Git runs with an empty global config and no system config, so filters,
 * hooks and fsmonitor commands from the user's or the project's config never
 * run, even for an untrusted checkout.
 */
export class ShadowRepo {
  readonly toplevel: string;
  readonly storeDir: string;
  /** Held around every multi-step operation on the store. */
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

  /**
   * Creates the store on first use and points it at the project's objects.
   * Runs under the store lock: two processes opening the same store at once
   * would otherwise race on `git init` and `git config`.
   */
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
    // Content the project already stores is read from its object database
    // instead of being copied. A restore checks every object before it
    // writes, in case the project pruned one.
    await fs.mkdir(path.join(storeDir, "objects", "info"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(storeDir, "objects", "info", "alternates"),
      path.join(this.config.projectCommonDir, "objects") + "\n",
    );
  }

  /** Runs git against the store, with the project as the work tree. */
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

  /** Paths, relative to the work tree, that differ between two trees. */
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

  /**
   * The entries of `files` that the store's ignore rules (the project's
   * `.gitignore` files, its `info/exclude`, the person's excludes file and
   * the size limit) leave out. Every path must have real parent folders:
   * git refuses a path beyond a symlink.
   */
  async ignored(files: readonly string[]): Promise<Set<string>> {
    if (files.length === 0) return new Set();
    // Exit 1 means none of the paths is ignored. check-ignore reads plain
    // paths and rejects the literal-pathspec setting.
    const { GIT_LITERAL_PATHSPECS: _literal, ...env } = this.env;
    const { stdout } = await this.git(
      ["check-ignore", "--no-index", "-z", "--stdin"],
      { env, input: files.join("\0") + "\0", okCodes: [0, 1] },
    );
    return new Set(splitNul(stdout));
  }

  /** The entries of `files` that exist in `tree`. Throws if git fails. */
  async lsTree(
    tree: string,
    files: readonly string[],
  ): Promise<Map<string, TreeEntry>> {
    const entries = new Map<string, TreeEntry>();
    for (const chunk of chunkByLength(files)) {
      // A failure here throws. Treating it as "not in the tree" would
      // delete files that do exist in the snapshot.
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
