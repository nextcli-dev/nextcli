import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { openSnapshotter, type Snapshotter } from "../src/index.js";

export interface Fixture {
  root: string;
  storeRoot: string;
  home: string;
  env: NodeJS.ProcessEnv;
  write(file: string, content: string | Buffer): void;
  git(...args: string[]): string;
  open(options?: { maxUntrackedFileBytes?: number }): Promise<Snapshotter>;
}

/** A fresh git repository with one commit, plus an isolated HOME and store. */
export function createFixture(): Fixture {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "cn-snapshot-")));
  const root = path.join(base, "project");
  const storeRoot = path.join(base, "store");
  const home = path.join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd: root, env, encoding: "utf8" },
    );
  const write = (file: string, content: string | Buffer) => {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };

  git("init", "-q");
  git("config", "core.autocrlf", "false");
  write("a.txt", "a1\n");
  write("b.txt", "b1\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  return {
    root,
    storeRoot,
    home,
    env,
    write,
    git,
    async open(options = {}) {
      const result = await openSnapshotter({
        cwd: root,
        storeRoot,
        env,
        ...options,
      });
      if (!result.ok) throw new Error(`disabled: ${result.reason}`);
      return result.snapshotter;
    },
  };
}
