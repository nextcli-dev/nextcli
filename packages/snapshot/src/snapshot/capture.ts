import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { chunkByLength, runGit, splitNul } from "../git/runGit.js";

import { workTreeEntry } from "./paths.js";
import { EMPTY_GITCONFIG, type ShadowRepo } from "./store.js";

export const REF_PREFIX = "refs/cn/";

/** `include`: ignored paths to record anyway. Caller holds the store lock. */
export async function captureTree(
  repo: ShadowRepo,
  pin?: string,
  include: readonly string[] = [],
): Promise<string> {
  await syncExcludes(repo);
  await repo.git(["add", "--all"]);
  let tree = (await repo.git(["write-tree"])).stdout.toString("utf8").trim();
  if (include.length > 0) tree = await withWorkTreePaths(repo, tree, include);
  if (pin) await pinTree(repo, tree, pin);
  return tree;
}

export async function pinTree(
  repo: ShadowRepo,
  tree: string,
  pin: string,
): Promise<void> {
  await repo.git([
    "update-ref",
    `${REF_PREFIX}${dateSegment(new Date())}/${sanitizePin(pin)}`,
    tree,
  ]);
}

/** Uses a temporary index, so later captures still follow the ignore rules. */
export async function withWorkTreePaths(
  repo: ShadowRepo,
  tree: string,
  files: readonly string[],
): Promise<string> {
  const present: string[] = [];
  const gone: string[] = [];
  for (const file of new Set(files)) {
    const entry = await workTreeEntry(repo, file);
    if (entry === "file") present.push(file);
    else if (entry === "none") gone.push(file);
  }
  const indexFile = path.join(repo.storeDir, `nextcli-${randomUUID()}.index`);
  const env = { ...repo.env, GIT_INDEX_FILE: indexFile };
  const fromStdin = ["--pathspec-from-file=-", "--pathspec-file-nul"];
  try {
    await repo.git(["read-tree", tree], { env });
    if (present.length > 0) {
      await repo.git(["add", "--force", ...fromStdin], {
        env,
        input: present.join("\0"),
      });
    }
    if (gone.length > 0) {
      await repo.git(
        ["rm", "--cached", "--quiet", "--ignore-unmatch", ...fromStdin],
        { env, input: gone.join("\0") },
      );
    }
    return (await repo.git(["write-tree"], { env })).stdout
      .toString("utf8")
      .trim();
  } finally {
    await fs.rm(indexFile, { force: true });
  }
}

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

/** Ignore rules outside the work tree, large untracked files, the store. */
export async function syncExcludes(repo: ShadowRepo): Promise<void> {
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
  if (config.storeRel) {
    lines.push("/" + escapeExcludePath(config.storeRel) + "/");
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
    // Can't be written as an exclude pattern
    if (file.includes("\n")) continue;
    const stat = await fs
      .lstat(path.join(repo.toplevel, file))
      .catch(() => undefined);
    if (stat?.isFile() && stat.size > config.maxUntrackedFileBytes) {
      candidates.push(file);
    }
  }
  if (candidates.length === 0) return [];
  // Files the project tracks are kept whatever their size
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

export function escapeExcludePath(file: string): string {
  return file
    .replace(/[\\*?[\]!#]/g, "\\$&")
    .replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
}
