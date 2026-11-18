import { promises as fs } from "node:fs";
import * as path from "node:path";

import { chunkByLength, runGit, splitNul } from "../git/runGit.js";

import { EMPTY_GITCONFIG, type ShadowRepo } from "./store.js";

export const REF_PREFIX = "refs/cn/";

/**
 * Records the current state of the work tree and returns its tree id. With
 * `pin`, the tree is kept by `refs/cn/<date>/<pin>` until it is pruned.
 * The caller holds the store lock.
 */
export async function captureTree(
  repo: ShadowRepo,
  pin?: string,
): Promise<string> {
  await syncExcludes(repo);
  await repo.git(["add", "--all"]);
  const tree = (await repo.git(["write-tree"])).stdout.toString("utf8").trim();
  if (pin) {
    await repo.git([
      "update-ref",
      `${REF_PREFIX}${dateSegment(new Date())}/${sanitizePin(pin)}`,
      tree,
    ]);
  }
  return tree;
}

/** `YYYYMMDD`, the date segment of pinned refs. */
export function dateSegment(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function sanitizePin(pin: string): string {
  return pin
    .split("/")
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_"))
    .filter((part) => part.length > 0)
    .join("/");
}

/**
 * Copies ignore rules that live outside the work tree into the store, and
 * leaves out large untracked files and the store itself.
 */
async function syncExcludes(repo: ShadowRepo): Promise<void> {
  const { config } = repo;
  const lines: string[] = ["# Written by NextCLI on every capture"];
  lines.push(
    await fs
      .readFile(path.join(config.projectCommonDir, "info", "exclude"), "utf8")
      .catch(() => ""),
  );
  const userExcludes = await userExcludesFile(repo);
  if (userExcludes) {
    lines.push(await fs.readFile(userExcludes, "utf8").catch(() => ""));
  }
  const storeRel = path.relative(repo.toplevel, config.storeRoot);
  if (storeRel && !storeRel.startsWith("..") && !path.isAbsolute(storeRel)) {
    lines.push("/" + escapeExcludePath(toPosix(storeRel)) + "/");
  }

  const excludePath = path.join(repo.storeDir, "info", "exclude");
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, lines.join("\n") + "\n");

  const large = await largeUntrackedFiles(repo);
  if (large.length > 0) {
    await fs.appendFile(
      excludePath,
      large.map((file) => "/" + escapeExcludePath(file)).join("\n") + "\n",
    );
  }
}

const userExcludesFiles = new WeakMap<
  ShadowRepo,
  Promise<string | undefined>
>();

/** The `core.excludesFile` from the person's own git config, if set. */
function userExcludesFile(repo: ShadowRepo): Promise<string | undefined> {
  let found = userExcludesFiles.get(repo);
  if (!found) {
    found = runGit(
      repo.config.gitBinary,
      ["config", "--global", "--path", "--get", "core.excludesFile"],
      { env: repo.config.baseEnv, okCodes: [0, 1] },
    )
      .then(({ stdout, code }) =>
        code === 0 ? stdout.toString("utf8").trim() || undefined : undefined,
      )
      .catch(() => undefined);
    userExcludesFiles.set(repo, found);
  }
  return found;
}

/**
 * Files that are neither in the project's index nor in an earlier snapshot,
 * and are over the size limit.
 */
async function largeUntrackedFiles(repo: ShadowRepo): Promise<string[]> {
  const { config } = repo;
  const { stdout } = await repo.git([
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
      .lstat(path.join(repo.toplevel, file))
      .catch(() => undefined);
    if (stat?.isFile() && stat.size > config.maxUntrackedFileBytes) {
      candidates.push(file);
    }
  }
  if (candidates.length === 0) return [];
  // The shadow index starts empty, so files the project tracks show up here
  // on the first capture. Keep those whatever their size.
  const tracked = new Set<string>();
  for (const chunk of chunkByLength(candidates)) {
    const { stdout: out } = await runGit(
      config.gitBinary,
      ["-c", "core.fsmonitor=false", "ls-files", "-z", "--", ...chunk],
      {
        env: {
          ...config.baseEnv,
          GIT_DIR: config.projectGitDir,
          GIT_WORK_TREE: repo.toplevel,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: path.join(repo.storeDir, EMPTY_GITCONFIG),
          GIT_LITERAL_PATHSPECS: "1",
        },
      },
    );
    for (const file of splitNul(out)) tracked.add(file);
  }
  return candidates.filter((file) => !tracked.has(file));
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
