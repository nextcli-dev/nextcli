import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { resolveEnvProviderConfig } from "./envProviderConfig.js";

describe("resolveEnvProviderConfig", () => {
  const models = (env: NodeJS.ProcessEnv) =>
    parse(resolveEnvProviderConfig(env)!.yaml).models;

  it("returns nothing without provider env vars", () => {
    expect(resolveEnvProviderConfig({})).toBeUndefined();
  });

  it("builds an Anthropic config from ANTHROPIC_API_KEY", () => {
    const result = resolveEnvProviderConfig({ ANTHROPIC_API_KEY: "sk-ant-x" });
    expect(result?.providerId).toBe("anthropic");
    expect(result?.source).toBe("ANTHROPIC_API_KEY");
    expect(models({ ANTHROPIC_API_KEY: "sk-ant-x" })[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      apiKey: "sk-ant-x",
    });
  });

  it("builds an OpenAI config from OPENAI_API_KEY alone", () => {
    expect(models({ OPENAI_API_KEY: "sk-x" })[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "sk-x",
    });
  });

  it("prefers ANTHROPIC_API_KEY when several keys are set", () => {
    expect(
      resolveEnvProviderConfig({
        OPENAI_API_KEY: "sk-x",
        ANTHROPIC_API_KEY: "sk-ant-x",
      })?.providerId,
    ).toBe("anthropic");
  });

  it("lets NEXTCLI_MODEL override the default model", () => {
    expect(
      models({ DEEPSEEK_API_KEY: "sk-x", NEXTCLI_MODEL: "deepseek-reasoner" }),
    ).toEqual([
      expect.objectContaining({
        provider: "deepseek",
        model: "deepseek-reasoner",
      }),
    ]);
  });

  it("supports an OpenAI-compatible gateway through NEXTCLI_PROVIDER", () => {
    expect(
      models({
        NEXTCLI_PROVIDER: "openai-compatible",
        NEXTCLI_MODEL: "my-model",
        NEXTCLI_MODEL_API_KEY: "gw-key",
        NEXTCLI_MODEL_BASE_URL: "https://gateway.example/v1",
      })[0],
    ).toMatchObject({
      provider: "openai",
      model: "my-model",
      apiKey: "gw-key",
      apiBase: "https://gateway.example/v1",
    });
  });

  it("uses the provider's own key env var with NEXTCLI_PROVIDER", () => {
    expect(
      models({ NEXTCLI_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" })[0],
    ).toMatchObject({ provider: "openai", apiKey: "sk-x" });
  });

  it("throws for an unknown or incomplete NEXTCLI_PROVIDER", () => {
    expect(() =>
      resolveEnvProviderConfig({ NEXTCLI_PROVIDER: "nope" }),
    ).toThrow('Unknown NEXTCLI_PROVIDER "nope"');
    expect(() =>
      resolveEnvProviderConfig({ NEXTCLI_PROVIDER: "openai" }),
    ).toThrow("needs NEXTCLI_MODEL_API_KEY or OPENAI_API_KEY");
    expect(() =>
      resolveEnvProviderConfig({
        NEXTCLI_PROVIDER: "openai-compatible",
        NEXTCLI_MODEL_API_KEY: "k",
      }),
    ).toThrow("needs NEXTCLI_MODEL_BASE_URL and NEXTCLI_MODEL");
  });

  it("allows Ollama without a key", () => {
    expect(models({ NEXTCLI_PROVIDER: "ollama" })[0]).toMatchObject({
      provider: "ollama",
      model: "llama3.1:8b",
    });
  });
});

describe("resolveEnvProviderConfig OneProvider", () => {
  it("picks OneProvider from ONEPROVIDER_API_KEY", () => {
    const result = resolveEnvProviderConfig({ ONEPROVIDER_API_KEY: "sk-one" });
    expect(result?.providerId).toBe("oneprovider");
    expect(result?.yaml).toContain("provider: oneprovider");
    expect(result?.yaml).toContain("model: claude-sonnet-5-5");
    expect(result?.yaml).toContain("model: deepseek-v4-pro");
  });

  it("accepts ONEPROVIDER_KEY, the name OneProvider's docs use", () => {
    const result = resolveEnvProviderConfig({ ONEPROVIDER_KEY: "sk-one" });
    expect(result?.providerId).toBe("oneprovider");
    expect(result?.source).toBe("ONEPROVIDER_KEY");
    expect(result?.yaml).toContain("apiKey: sk-one");
  });

  it("works with NEXTCLI_PROVIDER and a model", () => {
    const result = resolveEnvProviderConfig({
      NEXTCLI_PROVIDER: "oneprovider",
      NEXTCLI_MODEL: "gpt-6.1-sol",
      ONEPROVIDER_KEY: "sk-one",
    });
    expect(result?.yaml).toContain("model: gpt-6.1-sol");
  });
});
