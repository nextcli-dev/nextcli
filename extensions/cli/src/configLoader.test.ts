import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("loadConfiguration from provider env vars", () => {
  const ENV_KEYS = [
    "CONTINUE_GLOBAL_DIR",
    "NEXTCLI_API_BASE",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "NEXTCLI_PROVIDER",
    "NEXTCLI_MODEL",
  ];
  let savedEnv: Record<string, string | undefined>;
  let tempDir: string;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    ENV_KEYS.forEach((k) => delete process.env[k]);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nextcli-config-"));
    process.env.CONTINUE_GLOBAL_DIR = tempDir;
    vi.resetModules();
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnv[k];
      }
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function load() {
    const { loadConfiguration } = await import("./configLoader.js");
    return loadConfiguration(null, undefined, {} as any, [], true);
  }

  test("builds an in-memory config from OPENAI_API_KEY when there is no config.yaml", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";

    const { config, source } = await load();

    expect(source.type).toBe("env-config");
    expect(config.models?.[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
    });
    expect(fs.existsSync(path.join(tempDir, "config.yaml"))).toBe(false);
  });

  test("prefers an existing config.yaml over env vars", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    fs.writeFileSync(
      path.join(tempDir, "config.yaml"),
      "name: Mine\nversion: 1.0.0\nschema: v1\nmodels:\n  - name: Gateway\n    provider: openai\n    model: my-model\n    apiKey: gw\n",
    );

    const { config, source } = await load();

    expect(source.type).toBe("local-config-yaml");
    expect(config.models?.map((m: any) => m.model)).toEqual(["my-model"]);
  });

  test("lists the supported env vars when nothing is configured", async () => {
    await expect(load()).rejects.toThrow(/ANTHROPIC_API_KEY, OPENAI_API_KEY/);
  });
});
