import { describe, expect, it } from "vitest";

import { childProcessEnv, isSecretEnvVar } from "./childEnv.js";

describe("isSecretEnvVar", () => {
  it.each([
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
    ["GOOGLE_APPLICATION_CREDENTIALS", "/path/key.json"],
    ["ACTIONS_ID_TOKEN_REQUEST_URL", "https://example"],
    ["npm_config__authToken", "x"],
    // By value, under a harmless name
    ["LLM", "sk-proj-abcdefghijklmnop"],
    ["GH", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["AWS_ID", "AKIAIOSFODNN7EXAMPLE"],
    ["DATABASE_URL", "postgres://user:hunter2@db.internal:5432/app"],
    ["HTTPS_PROXY", "http://user:pass@proxy:3128"],
    ["DEPLOY", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc"],
  ])("strips %s", (name, value) => {
    expect(isSecretEnvVar(name, value)).toBe(true);
  });

  it.each([
    ["PATH", "/usr/bin:/bin"],
    ["HOME", "/home/runner"],
    ["LANG", "en_US.UTF-8"],
    ["CI", "true"],
    ["GITHUB_REPOSITORY", "nextcli-dev/nextcli"],
    ["GITHUB_SHA", "addb31266"],
    ["GITHUB_WORKSPACE", "/home/runner/work/app"],
    ["NODE_OPTIONS", "--max-old-space-size=4096"],
    ["SSH_AUTH_SOCK", "/tmp/ssh-agent.sock"],
    ["GPG_AGENT_INFO", "/run/gpg"],
    ["TOKENIZERS_PARALLELISM", "false"],
    ["DATABASE_URL", "postgres://localhost:5432/app"],
    ["HTTPS_PROXY", "http://proxy:3128"],
    ["TERM", "xterm-256color"],
    ["ACTIONS_RUNTIME_URL", "https://example"], // useless without its token
  ])("keeps %s", (name, value) => {
    expect(isSecretEnvVar(name, value)).toBe(false);
  });
});

describe("childProcessEnv", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/runner",
    OPENAI_API_KEY: "sk-test-abcdefghijk",
    GH_TOKEN: "ghs_abcdefghijklmnopqrstuvwxyz",
    CI: "true",
  };

  it("keeps the ordinary environment and drops the secrets", () => {
    expect(childProcessEnv([], env)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      CI: "true",
    });
  });

  it("keeps a variable named with --pass-env, in any case", () => {
    const result = childProcessEnv(["gh_token"], env);
    expect(result.GH_TOKEN).toBe(env.GH_TOKEN);
    expect(result.OPENAI_API_KEY).toBeUndefined();
  });

  it("doesn't change the process's own environment", () => {
    const copy = { ...env };
    childProcessEnv([], env);
    expect(env).toEqual(copy);
  });
});
