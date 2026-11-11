import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canAskForTrust,
  isNeverFromFile,
  loadProjectEnvironment,
} from "./projectEnv.js";
import { listStoredTrust } from "./workspaceTrust.js";

// The prompt's readline interface, driven by each test: answer the question
// or close the interface without an answer (Ctrl+D)
const prompt = vi.hoisted(() => ({
  onQuestion: undefined as
    | undefined
    | ((rl: { close(): void }, answer: (text: string) => void) => void),
}));
vi.mock("readline", async () => {
  const { EventEmitter } = await import("events");
  const createInterface = () => {
    const rl: any = new EventEmitter();
    rl.close = () => rl.emit("close");
    rl.question = (_query: string, callback: (text: string) => void) =>
      prompt.onQuestion?.(rl, callback);
    return rl;
  };
  return { default: { createInterface }, createInterface };
});

describe("loadProjectEnvironment", () => {
  let root: string;
  let repo: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  let stderr: PassThrough;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cn-boot-")));
    repo = path.join(root, "repo");
    home = path.join(root, "home", ".continue");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    env = { CONTINUE_GLOBAL_DIR: home, ALREADY_SET: "from-shell" };
    stderr = new PassThrough();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (
    options: {
      canAsk?: boolean;
      trustFlag?: boolean;
      quietNotice?: boolean;
      answer?: boolean;
    } = {},
  ) => {
    const ask = vi.fn(async () => options.answer ?? false);
    const result = loadProjectEnvironment({
      folder: repo,
      env,
      canAsk: options.canAsk ?? false,
      trustFlag: options.trustFlag ?? false,
      quietNotice: options.quietNotice,
      notice: (message) => stderr.write(message),
      ask,
    });
    return { result, ask };
  };

  const projectEnv = (text: string) =>
    fs.writeFileSync(path.join(repo, ".env"), text);

  it("loads ~/.continue/.env in every folder", async () => {
    fs.writeFileSync(path.join(home, ".env"), "USER_KEY=u\nALREADY_SET=file");
    await run().result;
    expect(env.USER_KEY).toBe("u");
    expect(env.ALREADY_SET).toBe("from-shell");
  });

  it("skips an untrusted folder's .env and says so", async () => {
    projectEnv("PROJECT_KEY=p");
    const { result, ask } = run();
    const report = await result;
    expect(ask).not.toHaveBeenCalled();
    expect(env.PROJECT_KEY).toBeUndefined();
    expect(report.trusted).toBe(false);
    expect(stderr.read()?.toString()).toMatch(/isn't trusted/);
  });

  it("loads a trusted folder's .env, under the existing variables", async () => {
    projectEnv("PROJECT_KEY=p\nALREADY_SET=file");
    fs.mkdirSync(path.join(repo, ".continue"));
    fs.writeFileSync(path.join(repo, ".continue", ".env"), "PROJECT_KEY=c");
    fs.writeFileSync(path.join(home, ".env"), "PROJECT_KEY=u");

    await run({ trustFlag: true }).result;

    // .continue/.env, then .env, then ~/.continue/.env; the shell wins
    expect(env.PROJECT_KEY).toBe("c");
    expect(env.ALREADY_SET).toBe("from-shell");
  });

  it("asks once when the run can ask, and saves the answer", async () => {
    projectEnv("PROJECT_KEY=p");
    const first = run({ canAsk: true, answer: true });
    await first.result;
    expect(first.ask).toHaveBeenCalledWith(repo);
    expect(env.PROJECT_KEY).toBe("p");
    expect(listStoredTrust(env)).toEqual({ [repo]: true });

    delete env.PROJECT_KEY;
    const second = run({ canAsk: true });
    await second.result;
    expect(second.ask).not.toHaveBeenCalled();
    expect(env.PROJECT_KEY).toBe("p");
  });

  it("remembers a refusal too", async () => {
    projectEnv("PROJECT_KEY=p");
    await run({ canAsk: true, answer: false }).result;
    expect(env.PROJECT_KEY).toBeUndefined();
    const again = run({ canAsk: true });
    await again.result;
    expect(again.ask).not.toHaveBeenCalled();
  });

  // A trusted folder can still be a cloned repository: these variables would
  // run code or redirect the key, so no file sets them
  it("never takes process-level variables from a file, trusted or not", async () => {
    projectEnv(
      [
        "NODE_OPTIONS=--require ./x.js",
        "GIT_CONFIG_COUNT=1",
        "GIT_CONFIG_KEY_0=core.fsmonitor",
        "HTTPS_PROXY=http://proxy",
        "https_proxy=http://proxy",
        "NODE_EXTRA_CA_CERTS=./ca.pem",
        "NODE_TLS_REJECT_UNAUTHORIZED=0",
        "npm_config_registry=https://registry.example.invalid/",
        "NPM_CONFIG_REGISTRY=https://registry.example.invalid/",
        "CONTINUE_GLOBAL_DIR=./x",
        "NEXTCLI_VERSION_INFO_URL=https://x",
        "OTEL_EXPORTER_OTLP_ENDPOINT=https://x",
        "PATH=./bin",
        "OPENAI_API_KEY=sk-legit",
      ].join("\n"),
    );

    const report = await run({ trustFlag: true }).result;

    expect(env.OPENAI_API_KEY).toBe("sk-legit");
    for (const name of [
      "NODE_OPTIONS",
      "GIT_CONFIG_COUNT",
      "HTTPS_PROXY",
      "https_proxy",
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "npm_config_registry",
      "NPM_CONFIG_REGISTRY",
      "NEXTCLI_VERSION_INFO_URL",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "PATH",
    ]) {
      expect(env[name], name).toBeUndefined();
    }
    expect(env.CONTINUE_GLOBAL_DIR).toBe(home);
    expect(report.skippedNames).toContain("NODE_OPTIONS");
  });

  it("says nothing about the .env when asked to be quiet", async () => {
    projectEnv("PROJECT_KEY=p");
    await run({ quietNotice: true }).result;
    expect(stderr.read()).toBeNull();
  });

  describe("the prompt", () => {
    const ask = () =>
      loadProjectEnvironment({
        folder: repo,
        env,
        canAsk: true,
        trustFlag: false,
        notice: () => {},
      });

    // Closing readline drops the question's callback: without settling on
    // close, the preAction hook would wait forever and cn never start
    it("settles as untrusted, saving nothing, when it is closed (Ctrl+D)", async () => {
      projectEnv("PROJECT_KEY=p");
      prompt.onQuestion = (rl) => rl.close();

      const report = await ask();

      expect(report.trusted).toBe(false);
      expect(env.PROJECT_KEY).toBeUndefined();
      expect(listStoredTrust(env)).toEqual({});
    }, 2000);

    it("takes a typed answer", async () => {
      projectEnv("PROJECT_KEY=p");
      prompt.onQuestion = (_rl, answer) => answer("y");

      const report = await ask();

      expect(report.trusted).toBe(true);
      expect(env.PROJECT_KEY).toBe("p");
      expect(listStoredTrust(env)).toEqual({ [repo]: true });
    });
  });

  // A read-only home or a file owned by someone else must not stop cn
  it("follows the answer for this run when it can't be saved", async () => {
    projectEnv("PROJECT_KEY=p");
    const blocked = path.join(root, "blocked");
    fs.writeFileSync(blocked, "");
    env.CONTINUE_GLOBAL_DIR = blocked;

    const report = await run({ canAsk: true, answer: true }).result;

    expect(report.trusted).toBe(true);
    expect(env.PROJECT_KEY).toBe("p");
  });
});

describe("canAskForTrust", () => {
  const base = {
    interactiveChat: true,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    env: {},
  };

  it("asks only in an interactive chat with a terminal", () => {
    expect(canAskForTrust(base)).toBe(true);
    expect(canAskForTrust({ ...base, interactiveChat: false })).toBe(false);
    expect(canAskForTrust({ ...base, stdinIsTTY: false })).toBe(false);
    expect(canAskForTrust({ ...base, stdoutIsTTY: false })).toBe(false);
    expect(canAskForTrust({ ...base, env: { FORCE_NO_TTY: "true" } })).toBe(
      false,
    );
  });
});

describe("isNeverFromFile", () => {
  it.each([
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "GIT_DIR",
    "no_proxy",
    "BASH_ENV",
    "npm_config_registry",
    "NODE_TLS_REJECT_UNAUTHORIZED",
  ])("%s", (name) => expect(isNeverFromFile(name)).toBe(true));

  // A trusted folder may still choose its model endpoint
  it.each([
    "OPENAI_API_KEY",
    "NEXTCLI_MODEL",
    "NEXTCLI_MODEL_BASE_URL",
    "GITHUB_TOKEN",
    "NODE_ENV",
  ])("allows %s", (name) => expect(isNeverFromFile(name)).toBe(false));
});
