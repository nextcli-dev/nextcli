import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  filterSecretEnv,
  isSecretEnvVar,
  posixUnsetPrelude,
  powershellUnsetPrelude,
  secureShellCommand,
} from "../src/index.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-env-"));
const credentialsFile = path.join(tmpDir, "service-account.json");
fs.writeFileSync(credentialsFile, "{}");

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// [name, value] pairs the shell must not see
const stripped: [string, string][] = [
  // By name
  ["OPENAI_API_KEY", "x"],
  ["ANTHROPIC_API_KEY", "x"],
  ["GH_TOKEN", "x"],
  ["GITHUB_TOKEN", "x"],
  ["NODE_AUTH_TOKEN", "x"],
  ["AWS_SECRET_ACCESS_KEY", "x"],
  ["AWS_SESSION_TOKEN", "x"],
  ["AWS_ACCESS_KEY_ID", "x"],
  ["DEEPSEEK_KEY", "x"],
  ["GITLAB_PAT", "x"],
  ["DB_PASSWORD", "x"],
  ["ACTIONS_ID_TOKEN_REQUEST_URL", "https://example"],
  ["npm_config__authToken", "x"],
  ["AZURE_CREDENTIALS", '{"clientSecret":"x"}'],
  // A credential variable that points to a file that isn't there
  ["GOOGLE_APPLICATION_CREDENTIALS", "/nonexistent/key.json"],
  // By value, under a harmless name
  ["LLM", "sk-proj-abcdefghijklmnop"],
  ["GH", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["AWS_ID", "AKIAIOSFODNN7EXAMPLE"],
  ["DATABASE_URL", "postgres://user:hunter2@db.internal:5432/app"],
  ["HTTPS_PROXY", "http://user:pass@proxy:3128"],
  ["DEPLOY", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----"],
];

// [name, value] pairs the shell keeps
const kept: [string, string][] = [
  ["PATH", "/usr/bin:/bin"],
  ["HOME", "/home/runner"],
  ["LANG", "en_US.UTF-8"],
  ["CI", "true"],
  ["GITHUB_REPOSITORY", "nextcli-dev/nextcli"],
  ["GITHUB_SHA", "addb31266"],
  ["NODE_OPTIONS", "--max-old-space-size=4096"],
  ["SSH_AUTH_SOCK", "/tmp/ssh-agent.sock"],
  ["TOKENIZERS_PARALLELISM", "false"],
  ["DATABASE_URL_LOCAL", "postgres://localhost:5432/app"],
  ["HTTP_PROXY", "http://proxy:3128"],
  ["ACTIONS_RUNTIME_URL", "https://example"],
  // Pointers to credential files: the shell can read the file anyway
  ["GOOGLE_APPLICATION_CREDENTIALS", credentialsFile],
  ["SSH_PRIVATE_KEY", credentialsFile],
];

describe("isSecretEnvVar", () => {
  it.each(stripped)("strips %s", (name, value) => {
    expect(isSecretEnvVar(name, value)).toBe(true);
  });

  it.each(kept)("keeps %s", (name, value) => {
    expect(isSecretEnvVar(name, value)).toBe(false);
  });
});

describe("filterSecretEnv", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/runner",
    OPENAI_API_KEY: "sk-test-abcdefghijk",
    GH_TOKEN: "ghs_abcdefghijklmnopqrstuvwxyz",
  };

  it("keeps the ordinary environment and names what it stripped", () => {
    expect(filterSecretEnv(env)).toEqual({
      env: { PATH: "/usr/bin", HOME: "/home/runner" },
      stripped: ["GH_TOKEN", "OPENAI_API_KEY"],
    });
  });

  it("keeps a variable it is asked to keep, in any case", () => {
    const { env: result } = filterSecretEnv(env, ["gh_token"]);
    expect(result.GH_TOKEN).toBe(env.GH_TOKEN);
    expect(result.OPENAI_API_KEY).toBeUndefined();
  });
});

/** Runs the prelude in a real shell and returns the names still set */
function namesAfterPosixPrelude(
  shell: string,
  env: Record<string, string>,
  keep: string[] = [],
): Set<string> {
  const result = spawnSync(
    shell,
    [
      "-c",
      `${posixUnsetPrelude(keep)}\nawk 'BEGIN { for (k in ENVIRON) print k }'`,
    ],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } },
  );
  expect(result.stderr.toString()).toBe("");
  return new Set(result.stdout.toString().trim().split("\n"));
}

const posixShells = ["sh", "bash", "zsh", "dash"].filter(
  (shell) =>
    process.platform !== "win32" &&
    spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0,
);

describe.each(posixShells)("posixUnsetPrelude in %s", (shell) => {
  // One variable per run: the table repeats some names with other values
  it("unsets exactly what isSecretEnvVar strips", () => {
    for (const [name, value] of [...stripped, ...kept]) {
      const remaining = namesAfterPosixPrelude(shell, { [name]: value });
      expect(
        remaining.has(name),
        `${name}=${value.slice(0, 20)} in ${shell}`,
      ).toBe(!isSecretEnvVar(name, value));
    }
  });

  it("keeps the names it is asked to keep", () => {
    const remaining = namesAfterPosixPrelude(
      shell,
      { GH_TOKEN: "x", OPENAI_API_KEY: "y" },
      ["gh_token"],
    );
    expect(remaining.has("GH_TOKEN")).toBe(true);
    expect(remaining.has("OPENAI_API_KEY")).toBe(false);
  });

  it("leaves nothing of its own behind", () => {
    const remaining = namesAfterPosixPrelude(shell, { PLAIN: "1" });
    expect([...remaining].filter((name) => name.startsWith("__cn_"))).toEqual(
      [],
    );
    expect(remaining.has("PLAIN")).toBe(true);
  });
});

describe.skipIf(process.platform !== "win32")("powershellUnsetPrelude", () => {
  it("removes exactly what isSecretEnvVar strips", () => {
    for (const [name, value] of [...stripped, ...kept]) {
      if (value.includes("\n") || value.startsWith("/")) continue;
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `${powershellUnsetPrelude()}; if (Test-Path Env:${name}) { 'set' } else { 'unset' }`,
        ],
        { env: { ...process.env, [name]: value } },
      );
      expect(result.stdout.toString().trim(), name).toBe(
        isSecretEnvVar(name, value) ? "unset" : "set",
      );
    }
  });
});

describe("secureShellCommand", () => {
  it("runs the prelude in a login shell before the command", () => {
    const { shell, args } = secureShellCommand("ls", ["GH_TOKEN"], {
      platform: "linux",
      shell: "/bin/zsh",
    });
    expect(shell).toBe("/bin/zsh");
    expect(args.slice(0, 2)).toEqual(["-l", "-c"]);
    expect(args[2]).toBe(`${posixUnsetPrelude(["GH_TOKEN"])}\nls`);
  });

  it("uses a POSIX shell when $SHELL isn't one", () => {
    const { shell } = secureShellCommand("ls", [], {
      platform: "darwin",
      shell: "/opt/homebrew/bin/fish",
    });
    expect(["/bin/bash", "/bin/sh"]).toContain(shell);
  });

  it("puts the PowerShell prelude before the command on Windows", () => {
    const { shell, args } = secureShellCommand("dir", [], {
      platform: "win32",
    });
    expect(shell).toBe("powershell.exe");
    expect(args.at(-1)).toBe(`${powershellUnsetPrelude()}; dir`);
  });
});
