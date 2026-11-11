import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isNeverFromFile, prepareEnvironment } from "./bootstrap.js";
import { listStoredTrust } from "./workspaceTrust.js";

describe("prepareEnvironment", () => {
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

  const tty = (isTTY: boolean) => ({ isTTY }) as any;
  const run = (
    options: { argv?: string[]; interactive?: boolean; answer?: boolean } = {},
  ) => {
    const ask = vi.fn(async () => options.answer ?? false);
    const result = prepareEnvironment({
      folder: repo,
      argv: options.argv ?? ["node", "cn"],
      env,
      stdin: tty(options.interactive ?? false),
      stdout: tty(options.interactive ?? false),
      stderr,
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
    const report = await run({ argv: ["node", "cn", "-p", "hi"] }).result;
    expect(env.PROJECT_KEY).toBeUndefined();
    expect(report.trusted).toBe(false);
    expect(stderr.read()?.toString()).toMatch(/isn't trusted/);
  });

  it("loads a trusted folder's .env, under the existing variables", async () => {
    projectEnv("PROJECT_KEY=p\nALREADY_SET=file");
    fs.mkdirSync(path.join(repo, ".continue"));
    fs.writeFileSync(path.join(repo, ".continue", ".env"), "PROJECT_KEY=c");
    fs.writeFileSync(path.join(home, ".env"), "PROJECT_KEY=u");

    await run({ argv: ["node", "cn", "--trust-workspace"] }).result;

    // .continue/.env, then .env, then ~/.continue/.env; the shell wins
    expect(env.PROJECT_KEY).toBe("c");
    expect(env.ALREADY_SET).toBe("from-shell");
  });

  it("asks once in an interactive run and saves the answer", async () => {
    projectEnv("PROJECT_KEY=p");
    const first = run({ interactive: true, answer: true });
    await first.result;
    expect(first.ask).toHaveBeenCalledWith(repo);
    expect(env.PROJECT_KEY).toBe("p");
    expect(listStoredTrust(env)).toEqual({ [repo]: true });

    delete env.PROJECT_KEY;
    const second = run({ interactive: true });
    await second.result;
    expect(second.ask).not.toHaveBeenCalled();
    expect(env.PROJECT_KEY).toBe("p");
  });

  it("remembers a refusal too", async () => {
    projectEnv("PROJECT_KEY=p");
    await run({ interactive: true, answer: false }).result;
    expect(env.PROJECT_KEY).toBeUndefined();
    const again = run({ interactive: true });
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
        "CONTINUE_GLOBAL_DIR=./x",
        "NEXTCLI_VERSION_INFO_URL=https://x",
        "OTEL_EXPORTER_OTLP_ENDPOINT=https://x",
        "PATH=./bin",
        "OPENAI_API_KEY=sk-legit",
      ].join("\n"),
    );

    const report = await run({ argv: ["node", "cn", "--trust-workspace"] })
      .result;

    expect(env.OPENAI_API_KEY).toBe("sk-legit");
    for (const name of [
      "NODE_OPTIONS",
      "GIT_CONFIG_COUNT",
      "HTTPS_PROXY",
      "https_proxy",
      "NODE_EXTRA_CA_CERTS",
      "NEXTCLI_VERSION_INFO_URL",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "PATH",
    ]) {
      expect(env[name], name).toBeUndefined();
    }
    expect(env.CONTINUE_GLOBAL_DIR).toBe(home);
    expect(report.skippedNames).toContain("NODE_OPTIONS");
  });

  it("doesn't tell the review worker about the .env", async () => {
    projectEnv("PROJECT_KEY=p");
    await run({ argv: ["node", "cn", "--internal-review-worker"] }).result;
    expect(stderr.read()).toBeNull();
  });
});

describe("isNeverFromFile", () => {
  it.each([
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "GIT_DIR",
    "no_proxy",
    "BASH_ENV",
  ])("%s", (name) => expect(isNeverFromFile(name)).toBe(true));

  it.each(["OPENAI_API_KEY", "NEXTCLI_MODEL", "GITHUB_TOKEN", "NODE_ENV"])(
    "allows %s",
    (name) => expect(isNeverFromFile(name)).toBe(false),
  );
});
