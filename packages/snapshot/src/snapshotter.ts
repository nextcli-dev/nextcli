import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  chunkByLength,
  cleanEnv,
  parseGitVersion,
  runGit,
  splitNul,
} from "./git.js";
import { StoreLock } from "./lock.js";
import type {
  DisabledReason,
  RestoreResult,
  RestoreTarget,
  RevertPlan,
  TurnSnapshot,
} from "./types.js";

/** Untracked files above this size are left out of snapshots. */
export const DEFAULT_MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;
/** Pinned snapshots older than this are deleted by `prune`. */
export const DEFAULT_MAX_AGE_DAYS = 30;

const MIN_GIT: [number, number] = [2, 26];
const REF_PREFIX = "refs/cn/";
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const EMPTY_GITCONFIG = "nextcli-empty.gitconfig";
const HOOKS_DIR = "nextcli-hooks";
const LOCK_FILE = "nextcli.lock";
const PRUNE_STAMP = "nextcli-last-prune";

export interface OpenSnapshotterOptions {
  /** Any directory inside the work tree. */
  cwd: string;
  /** Directory that holds one store per work tree, e.g. `~/.continue/snapshots`. */
  storeRoot: string;
  gitBinary?: string;
  maxUntrackedFileBytes?: number;
  /** Defaults to `process.env`. Inherited `GIT_*` variables are dropped. */
  env?: NodeJS.ProcessEnv;
}

export type OpenSnapshotterResult =
  | { ok: true; snapshotter: Snapshotter }
  | { ok: false; reason: DisabledReason; detail?: string };

/**
 * Opens (and creates on first use) the shadow repository for the git work
 * tree that contains `cwd`. Folders outside a git repository get no
 * snapshots.
 */
export async function openSnapshotter(
  options: OpenSnapshotterOptions,
): Promise<OpenSnapshotterResult> {
  const gitBinary = options.gitBinary ?? "git";
  const baseEnv = cleanEnv(options.env ?? process.env);

  let versionOutput: string;
  try {
    versionOutput = (
      await runGit(gitBinary, ["--version"], { env: baseEnv })
    ).stdout.toString("utf8");
  } catch (error) {
    return {
      ok: false,
      reason: "git-not-found",
      detail: (error as Error).message,
    };
  }
  const version = parseGitVersion(versionOutput);
  if (
    !version ||
    version[0] < MIN_GIT[0] ||
    (version[0] === MIN_GIT[0] && version[1] < MIN_GIT[1])
  ) {
    return { ok: false, reason: "git-too-old", detail: versionOutput.trim() };
  }

  let toplevel: string;
  let gitDir: string;
  let commonDir: string;
  try {
    const out = (
      await runGit(
        gitBinary,
        ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"],
        { env: baseEnv, cwd: options.cwd },
      )
    ).stdout
      .toString("utf8")
      .split(/\r?\n/);
    if (!out[0] || !out[1] || !out[2]) throw new Error("no work tree");
    toplevel = await fs.realpath(out[0]);
    gitDir = path.resolve(options.cwd, out[1]);
    commonDir = path.resolve(options.cwd, out[2]);
  } catch (error) {
    return {
      ok: false,
      reason: "not-a-git-repo",
      detail: (error as Error).message,
    };
  }

  try {
    const storeDir = path.join(options.storeRoot, storeKey(toplevel));
    const snapshotter = new Snapshotter({
      gitBinary,
      baseEnv,
      toplevel,
      projectGitDir: gitDir,
      projectCommonDir: commonDir,
      storeRoot: path.resolve(options.storeRoot),
      storeDir,
      maxUntrackedFileBytes:
        options.maxUntrackedFileBytes ?? DEFAULT_MAX_UNTRACKED_FILE_BYTES,
    });
    await snapshotter.init();
    return { ok: true, snapshotter };
  } catch (error) {
    return { ok: false, reason: "error", detail: (error as Error).message };
  }
}

/** Name of the store directory for a work tree. */
export function storeKey(toplevel: string): string {
  return createHash("sha256").update(toplevel).digest("hex").slice(0, 32);
}

interface SnapshotterConfig {
  gitBinary: string;
  baseEnv: NodeJS.ProcessEnv;
  toplevel: string;
  projectGitDir: string;
  projectCommonDir: string;
  storeRoot: string;
  storeDir: string;
  maxUntrackedFileBytes: number;
}

interface TreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

/**
 * A shadow git repository whose work tree is the project. It records trees
 * (no commits, no branches) and never touches the project's own `.git`.
 *
 * Git runs with an empty global config and no system config, so filters,
 * hooks and fsmonitor commands from the user's or the project's config never
 * run, even for an untrusted checkout.
 */
export class Snapshotter {
  readonly toplevel: string;
  readonly storeDir: string;
  private readonly lock: StoreLock;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly config: SnapshotterConfig) {
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

  /** @internal Called by `openSnapshotter`. */
  async init(): Promise<void> {
    const { storeDir } = this.config;
    await fs.mkdir(path.join(storeDir, HOOKS_DIR), { recursive: true });
    await fs.writeFile(path.join(storeDir, EMPTY_GITCONFIG), "");
    const initialised = await exists(path.join(storeDir, "HEAD"));
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
    // instead of being copied. `restore` checks every object before it
    // writes, in case the project pruned one.
    await fs.mkdir(path.join(storeDir, "objects", "info"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(storeDir, "objects", "info", "alternates"),
      path.join(this.config.projectCommonDir, "objects") + "\n",
    );
  }

  /**
   * Records the current state of the work tree and returns its tree id.
   * With `pin`, the tree is kept by `refs/cn/<date>/<pin>` until `prune`
   * removes it.
   */
  capture(pin?: string): Promise<string> {
    return this.lock.run(() => this.captureUnlocked(pin));
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

  /** Captures the end of a turn and lists the files it changed. */
  async finishTurn(
    start: string,
    pin?: string,
  ): Promise<{ end: string; files: string[] }> {
    const end = await this.capture(pin);
    return { end, files: await this.changedFiles(start, end) };
  }

  /**
   * Works out how to undo `turns` (oldest first): which version of each file
   * to put back and which files someone changed after the agent did.
   */
  planRevert(turns: readonly TurnSnapshot[]): Promise<RevertPlan> {
    return this.lock.run(async () => {
      const current = await this.captureUnlocked();
      const target = new Map<string, string>();
      const lastEnd = new Map<string, string>();
      for (const [index, turn] of turns.entries()) {
        const end = turn.end ?? turns[index + 1]?.start ?? current;
        const files = turn.files ?? (await this.changedFiles(turn.start, end));
        for (const file of files) {
          if (!target.has(file)) target.set(file, turn.start);
          lastEnd.set(file, end);
        }
      }

      const conflicts: string[] = [];
      for (const [end, files] of groupBy(lastEnd)) {
        const changed = new Set(await this.changedFiles(end, current));
        conflicts.push(...files.filter((file) => changed.has(file)));
      }

      const targets = [...target].map(([file, tree]) => ({ path: file, tree }));
      const restore: string[] = [];
      const remove: string[] = [];
      for (const [tree, files] of groupBy(target)) {
        const present = await this.lsTree(tree, files);
        for (const file of files) {
          (present.has(file) ? restore : remove).push(file);
        }
      }
      return {
        targets,
        restore: restore.sort(),
        delete: remove.sort(),
        conflicts: conflicts.sort(),
      };
    });
  }

  /**
   * Puts each target path back to its version in the target tree, deleting
   * it if the tree doesn't have it. Fails before changing any file if a
   * needed object is missing.
   */
  restore(targets: readonly RestoreTarget[]): Promise<RestoreResult> {
    return this.lock.run(() => this.restoreUnlocked(targets));
  }

  /**
   * Deletes pinned snapshots older than `maxAgeDays`, then lets git drop the
   * objects nothing refers to. Runs at most once a day unless `force`.
   */
  prune(
    options: { maxAgeDays?: number; force?: boolean; now?: Date } = {},
  ): Promise<{ deletedRefs: number; ran: boolean }> {
    return this.lock.run(async () => {
      const now = options.now ?? new Date();
      const stamp = path.join(this.storeDir, PRUNE_STAMP);
      if (!options.force) {
        const last = Date.parse(
          await fs.readFile(stamp, "utf8").catch(() => ""),
        );
        if (now.getTime() - last < PRUNE_INTERVAL_MS) {
          return { deletedRefs: 0, ran: false };
        }
      }
      const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
      const cutoff = dateSegment(
        new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000),
      );
      const { stdout } = await this.git([
        "for-each-ref",
        "--format=%(refname)",
        REF_PREFIX,
      ]);
      const expired = stdout
        .toString("utf8")
        .split("\n")
        .filter((ref) => {
          const date = ref.slice(REF_PREFIX.length).split("/")[0];
          return ref.length > 0 && date !== undefined && date < cutoff;
        });
      if (expired.length > 0) {
        await this.git(["update-ref", "--stdin"], {
          input: expired.map((ref) => `delete ${ref}\n`).join(""),
        });
      }
      // A day of grace keeps objects that a capture in another process has
      // written but not pinned yet.
      await this.git(["gc", "--quiet", "--prune=1.day.ago"]);
      await fs.writeFile(stamp, now.toISOString());
      return { deletedRefs: expired.length, ran: true };
    });
  }

  private async captureUnlocked(pin?: string): Promise<string> {
    await this.syncExcludes();
    await this.git(["add", "--all"]);
    const tree = (await this.git(["write-tree"])).stdout
      .toString("utf8")
      .trim();
    if (pin) {
      await this.git([
        "update-ref",
        `${REF_PREFIX}${dateSegment(new Date())}/${sanitizePin(pin)}`,
        tree,
      ]);
    }
    return tree;
  }

  private async restoreUnlocked(
    targets: readonly RestoreTarget[],
  ): Promise<RestoreResult> {
    for (const target of targets) this.resolveInside(target.path);
    const redoTree = await this.captureUnlocked(
      `redo/${Date.now()}-${process.pid}`,
    );

    const byTree = groupBy(new Map(targets.map((t) => [t.path, t.tree])));
    const present = new Map<string, TreeEntry[]>();
    const absent: string[] = [];
    const skipped: string[] = [];
    for (const [tree, files] of byTree) {
      const entries = await this.lsTree(tree, files);
      const restorable: TreeEntry[] = [];
      for (const file of files) {
        const entry = entries.get(file);
        if (!entry) absent.push(file);
        else if (entry.type === "commit") skipped.push(file);
        else restorable.push(entry);
      }
      present.set(tree, restorable);
    }

    const allEntries = [...present.values()].flat();
    await this.assertObjectsExist(allEntries.map((entry) => entry.object));

    const restored: string[] = [];
    for (const [tree, entries] of present) {
      if (entries.length === 0) continue;
      const paths = entries.map((entry) => entry.path);
      await this.git(
        ["checkout", tree, "--pathspec-from-file=-", "--pathspec-file-nul"],
        { input: paths.join("\0") },
      );
      restored.push(...paths);
    }

    // `.gitignore` files are back to their old version now, so this sees
    // the rules from before the undone turns.
    const ignored = await this.checkIgnored(absent);
    const deleted: string[] = [];
    const keptIgnored: string[] = [];
    for (const file of absent) {
      if (ignored.has(file)) {
        keptIgnored.push(file);
        continue;
      }
      const full = this.resolveInside(file);
      const stat = await fs.lstat(full).catch(() => undefined);
      if (stat && !stat.isDirectory()) {
        await fs.rm(full, { force: true });
        await this.removeEmptyParents(full);
      }
      deleted.push(file);
    }

    return {
      restored: restored.sort(),
      deleted: deleted.sort(),
      keptIgnored: keptIgnored.sort(),
      skipped: skipped.sort(),
      redoTree,
    };
  }

  /**
   * Copies ignore rules that live outside the work tree into the store, and
   * leaves out large untracked files and the store itself.
   */
  private async syncExcludes(): Promise<void> {
    const lines: string[] = ["# Written by NextCLI on every capture"];
    const projectExclude = await fs
      .readFile(
        path.join(this.config.projectCommonDir, "info", "exclude"),
        "utf8",
      )
      .catch(() => "");
    lines.push(projectExclude);
    const userExcludes = await this.userExcludesFile();
    if (userExcludes) {
      lines.push(await fs.readFile(userExcludes, "utf8").catch(() => ""));
    }
    const storeRel = path.relative(this.toplevel, this.config.storeRoot);
    if (storeRel && !storeRel.startsWith("..") && !path.isAbsolute(storeRel)) {
      lines.push("/" + escapeExcludePath(toPosix(storeRel)) + "/");
    }

    const excludePath = path.join(this.storeDir, "info", "exclude");
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.writeFile(excludePath, lines.join("\n") + "\n");

    const large = await this.largeUntrackedFiles();
    if (large.length > 0) {
      await fs.appendFile(
        excludePath,
        large.map((file) => "/" + escapeExcludePath(file)).join("\n") + "\n",
      );
    }
  }

  private userExcludesFilePromise: Promise<string | undefined> | undefined;

  /** The `core.excludesFile` from the person's own git config, if set. */
  private userExcludesFile(): Promise<string | undefined> {
    this.userExcludesFilePromise ??= runGit(
      this.config.gitBinary,
      ["config", "--global", "--path", "--get", "core.excludesFile"],
      { env: this.config.baseEnv, okCodes: [0, 1] },
    )
      .then(({ stdout, code }) =>
        code === 0 ? stdout.toString("utf8").trim() || undefined : undefined,
      )
      .catch(() => undefined);
    return this.userExcludesFilePromise;
  }

  /**
   * Files that are neither in the project's index nor in an earlier
   * snapshot, and are over the size limit.
   */
  private async largeUntrackedFiles(): Promise<string[]> {
    const { stdout } = await this.git([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const candidates: string[] = [];
    for (const file of splitNul(stdout)) {
      // A newline can't be written as an exclude pattern; let it through.
      if (file.includes("\n")) continue;
      const stat = await fs
        .lstat(path.join(this.toplevel, file))
        .catch(() => undefined);
      if (stat?.isFile() && stat.size > this.config.maxUntrackedFileBytes) {
        candidates.push(file);
      }
    }
    if (candidates.length === 0) return [];
    // The shadow index starts empty, so files the project tracks show up
    // here on the first capture. Keep those whatever their size.
    const tracked = new Set<string>();
    for (const chunk of chunkByLength(candidates)) {
      const { stdout: out } = await runGit(
        this.config.gitBinary,
        ["-c", "core.fsmonitor=false", "ls-files", "-z", "--", ...chunk],
        {
          env: {
            ...this.config.baseEnv,
            GIT_DIR: this.config.projectGitDir,
            GIT_WORK_TREE: this.toplevel,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: path.join(this.storeDir, EMPTY_GITCONFIG),
            GIT_LITERAL_PATHSPECS: "1",
          },
        },
      );
      for (const file of splitNul(out)) tracked.add(file);
    }
    return candidates.filter((file) => !tracked.has(file));
  }

  private async lsTree(
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

  private async assertObjectsExist(objects: readonly string[]): Promise<void> {
    if (objects.length === 0) return;
    const { stdout } = await this.git(["cat-file", "--batch-check"], {
      input: objects.join("\n") + "\n",
    });
    const missing = stdout
      .toString("utf8")
      .split("\n")
      .filter((line) => line.endsWith(" missing"))
      .map((line) => line.split(" ")[0]);
    if (missing.length > 0) {
      throw new Error(
        `Snapshot objects are missing (${missing.length}), so no file was changed. ` +
          `The project's git may have pruned them. First missing: ${missing[0]}`,
      );
    }
  }

  private async checkIgnored(files: readonly string[]): Promise<Set<string>> {
    if (files.length === 0) return new Set();
    // Exit 1 means none of the paths is ignored. check-ignore reads plain
    // paths and rejects the literal-pathspec setting.
    const { GIT_LITERAL_PATHSPECS: _literal, ...env } = this.env;
    const { stdout } = await runGit(
      this.config.gitBinary,
      ["check-ignore", "--no-index", "-z", "--stdin"],
      {
        env,
        cwd: this.toplevel,
        input: files.join("\0") + "\0",
        okCodes: [0, 1],
      },
    );
    return new Set(splitNul(stdout));
  }

  private resolveInside(file: string): string {
    const full = path.resolve(this.toplevel, file);
    const rel = path.relative(this.toplevel, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `Refusing to touch a path outside the work tree: ${file}`,
      );
    }
    return full;
  }

  private async removeEmptyParents(file: string): Promise<void> {
    let dir = path.dirname(file);
    while (dir !== this.toplevel && dir.startsWith(this.toplevel)) {
      try {
        await fs.rmdir(dir);
      } catch {
        return;
      }
      dir = path.dirname(dir);
    }
  }

  private git(
    args: string[],
    options: { input?: string; okCodes?: number[] } = {},
  ) {
    return runGit(this.config.gitBinary, args, {
      env: this.env,
      cwd: this.toplevel,
      ...options,
    });
  }
}

function groupBy(map: Map<string, string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [key, value] of map) {
    const list = groups.get(value);
    if (list) list.push(key);
    else groups.set(value, [key]);
  }
  return groups;
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

function dateSegment(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function sanitizePin(pin: string): string {
  return pin
    .split("/")
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_"))
    .filter((part) => part.length > 0)
    .join("/");
}

function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

/** Escapes a literal path for a gitignore-style exclude file. */
export function escapeExcludePath(file: string): string {
  return file
    .replace(/[\\*?[\]!#]/g, "\\$&")
    .replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
}
