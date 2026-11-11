import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isWorkspaceTrusted,
  listStoredTrust,
  setStoredTrust,
  setWorkspaceTrusted,
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

  const decide = (overrides: { trustFlag?: boolean; canAsk?: boolean } = {}) =>
    trustDecision({
      folder: repo,
      env,
      trustFlag: overrides.trustFlag ?? false,
      canAsk: overrides.canAsk ?? true,
    });

  describe("trustDecision", () => {
    it("asks, when the run can, if the folder has a .env", () => {
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
      expect(decide({ canAsk: false })).toBe("untrusted");
    });

    it("uses a stored decision, for the folder or a parent", () => {
      fs.writeFileSync(path.join(repo, ".env"), "A=1");
      setStoredTrust(path.join(root, "projects"), true, env);
      expect(decide({ canAsk: false })).toBe("trusted");
    });

    // cn untrust on a folder inside a trusted one
    it("lets a refused folder win over a trusted parent", () => {
      setStoredTrust(path.join(root, "projects"), true, env);
      setStoredTrust(repo, false, env);
      expect(decide()).toBe("untrusted");
      expect(storedTrust(path.join(root, "projects"), env)).toBe(true);
    });

    it("trusts for one run with --trust-workspace or NEXTCLI_TRUST_WORKSPACE", () => {
      expect(decide({ trustFlag: true, canAsk: false })).toBe("trusted");
      env.NEXTCLI_TRUST_WORKSPACE = "1";
      expect(decide({ canAsk: false })).toBe("trusted");
      expect(listStoredTrust(env)).toEqual({});
    });

    it("matches a folder reached through a symlink", () => {
      setStoredTrust(repo, true, env);
      const link = path.join(root, "link");
      fs.symlinkSync(repo, link);
      expect(storedTrust(link, env)).toBe(true);
    });
  });

  describe("the store", () => {
    it("replaces a decision and keeps the others", () => {
      setStoredTrust(repo, true, env);
      setStoredTrust(root, false, env);
      setStoredTrust(repo, false, env);
      expect(listStoredTrust(env)).toEqual({ [repo]: false, [root]: false });
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

  it("isWorkspaceTrusted is false until the run sets it", () => {
    expect(isWorkspaceTrusted()).toBe(false);
    setWorkspaceTrusted(true);
    expect(isWorkspaceTrusted()).toBe(true);
    setWorkspaceTrusted(false);
  });
});
