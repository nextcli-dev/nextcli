import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isInteractiveRun,
  isWorkspaceTrusted,
  listStoredTrust,
  setStoredTrust,
  storedTrust,
  trustDecision,
} from "./workspaceTrust.js";

describe("workspaceTrust", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cn-trust-")));
    repo = path.join(root, "projects", "repo");
    fs.mkdirSync(repo, { recursive: true });
    env = { CONTINUE_GLOBAL_DIR: path.join(root, "home", ".continue") };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const decide = (overrides: { argv?: string[]; interactive?: boolean } = {}) =>
    trustDecision({
      folder: repo,
      argv: overrides.argv ?? ["node", "cn"],
      env,
      interactive: overrides.interactive ?? true,
    });

  describe("trustDecision", () => {
    it("asks in an interactive run when the folder has a .env", () => {
      fs.writeFileSync(path.join(repo, ".env"), "A=1");
      expect(decide()).toBe("ask");
    });

    it("asks about .continue/.env too", () => {
      fs.mkdirSync(path.join(repo, ".continue"));
      fs.writeFileSync(path.join(repo, ".continue", ".env"), "A=1");
      expect(decide()).toBe("ask");
    });

    it("doesn't ask when there is nothing to load", () => {
      expect(decide()).toBe("untrusted");
    });

    it("is untrusted, without asking, when the run can't ask", () => {
      fs.writeFileSync(path.join(repo, ".env"), "A=1");
      expect(decide({ interactive: false })).toBe("untrusted");
    });

    it("uses a stored decision, for the folder or a parent", () => {
      fs.writeFileSync(path.join(repo, ".env"), "A=1");
      setStoredTrust(path.join(root, "projects"), true, env);
      expect(decide({ interactive: false })).toBe("trusted");

      setStoredTrust(repo, false, env);
      expect(decide()).toBe("untrusted");
    });

    it("trusts for one run with --trust-workspace or NEXTCLI_TRUST_WORKSPACE", () => {
      expect(
        decide({
          argv: ["node", "cn", "-p", "--trust-workspace"],
          interactive: false,
        }),
      ).toBe("trusted");
      env.NEXTCLI_TRUST_WORKSPACE = "1";
      expect(decide({ interactive: false })).toBe("trusted");
      expect(listStoredTrust(env)).toEqual({});
    });

    it("matches a folder reached through a symlink", () => {
      setStoredTrust(repo, true, env);
      const link = path.join(root, "link");
      fs.symlinkSync(repo, link);
      expect(storedTrust(link, env)).toBe(true);
    });
  });

  describe("isInteractiveRun", () => {
    it.each([
      [["node", "cn"], true],
      [["node", "cn", "--config", "x.yaml"], true],
      [["node", "cn", "-p", "hi"], false],
      [["node", "cn", "--print", "hi"], false],
      [["node", "cn", "review"], false],
      [["node", "cn", "serve"], false],
      [["node", "cn", "--internal-review-worker"], false],
      [["node", "cn", "trust"], false],
    ])("%j → %s", (argv, expected) => {
      expect(isInteractiveRun(argv, true, true)).toBe(expected);
    });

    it("never asks without a terminal", () => {
      expect(isInteractiveRun(["node", "cn"], false, true)).toBe(false);
      expect(isInteractiveRun(["node", "cn"], true, false)).toBe(false);
    });
  });

  describe("the store", () => {
    it("forgets a decision and keeps the others", () => {
      setStoredTrust(repo, true, env);
      setStoredTrust(root, false, env);
      setStoredTrust(repo, undefined, env);
      expect(listStoredTrust(env)).toEqual({ [root]: false });
    });

    it("is readable only by the person", () => {
      setStoredTrust(repo, true, env);
      const mode = fs.statSync(
        path.join(env.CONTINUE_GLOBAL_DIR!, "trusted-folders.json"),
      ).mode;
      if (process.platform !== "win32") expect(mode & 0o077).toBe(0);
    });

    it("treats a broken store as no decisions", () => {
      fs.mkdirSync(env.CONTINUE_GLOBAL_DIR!, { recursive: true });
      fs.writeFileSync(
        path.join(env.CONTINUE_GLOBAL_DIR!, "trusted-folders.json"),
        "{not json",
      );
      expect(storedTrust(repo, env)).toBeUndefined();
    });
  });

  it("isWorkspaceTrusted never asks", () => {
    fs.writeFileSync(path.join(repo, ".env"), "A=1");
    expect(isWorkspaceTrusted(repo, ["node", "cn"], env)).toBe(false);
    setStoredTrust(repo, true, env);
    expect(isWorkspaceTrusted(repo, ["node", "cn"], env)).toBe(true);
  });
});
