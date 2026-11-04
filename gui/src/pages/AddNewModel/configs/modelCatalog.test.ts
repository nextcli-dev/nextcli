import { setupProviderConfig } from "core/config/onboarding";
import { describe, expect, it } from "vitest";
// Read as text so the test doesn't pull the CLI's dependency graph into the GUI build
import cliPresetsSource from "../../../../../extensions/cli/src/util/providerPresets.ts?raw";
import {
  allModelProviders,
  findLlmInfo,
  isRetired,
} from "../../../../../packages/llm-info/src/index";
import { models } from "./models";
import { providers } from "./providers";

// Models the vendors have shut down (vendor docs as of 2026-11-04). No preset or
// default may use them; existing configs fall back to live model listing.
const RETIRED_MODEL_PATTERNS: RegExp[] = [
  // OpenAI
  /^gpt-3\.5/,
  /^gpt-35/,
  /^gpt-4$/,
  /^gpt-4-32k/,
  /^gpt-4-turbo/,
  /^gpt-4-vision/,
  /^gpt-4-.*preview/,
  /^gpt-4\.1-nano/,
  /^o1(?:-|$)/,
  /^o3-mini/,
  /^o4-mini/,
  /^codex-mini/,
  /^gpt-5-codex/,
  /^gpt-5\.[12]-codex/,
  /^chatgpt-4o-latest/,
  /^gpt-5(?:\.\d)?-chat-latest/,
  /^gpt-4o-2024-05-13/,
  /^(?:babbage|davinci)-002/,
  // Anthropic
  /^claude-2/,
  /^claude-instant/,
  /^claude-3/,
  /^claude-opus-4(?:-20250514)?$/,
  /^claude-sonnet-4-20250514/,
  /^claude-opus-4[.-]1/,
  /^claude-4-sonnet/,
  // Gemini
  /^gemini-2\.0-/,
  /^gemini-2\.5-(?:pro|flash)-preview/,
  /^gemini-3\.1-flash-lite-preview/,
  /^gemini-3-pro-preview/,
  /text-embedding-004/,
  // xAI
  /^grok-beta/,
  /^grok-2/,
  /^grok-3/,
  /^grok-4$/,
  /^grok-4-0709/,
  /^grok-4-fast/,
  /^grok-4-1-fast/,
  /^grok-code-fast-1/,
  // DeepSeek
  /^deepseek-(?:chat|reasoner|coder)$/,
  // Mistral
  /^open-mistral-7b/,
  /^open-mixtral-/,
  /^codestral-mamba/,
  /^devstral-small-2505/,
  /^devstral-2512/,
  /^magistral-/,
  // Cohere
  /^command-r-03-2024/,
  /^command-r-plus-04-2024/,
  /^c4ai-aya-(?:expanse|vision)/,
  // Moonshot
  /^moonshot-v1-/,
  /^kimi-k2\.5/,
  // Z.ai
  /^glm-4-plus$/,
  /^glm-4\.5$/,
];

const isRetiredId = (model: string) =>
  RETIRED_MODEL_PATTERNS.some((pattern) => pattern.test(model));

// GUI provider ids that differ from the llm-info provider ids
const LLM_INFO_PROVIDER: Record<string, string> = {
  oneprovider: "anthropic",
};

function problemsFor(provider: string, model: string): string[] {
  if (model === "AUTODETECT" || model === "placeholder") {
    return [];
  }
  const problems: string[] = [];
  if (isRetiredId(model)) {
    problems.push(`${provider}/${model} is retired`);
  }
  const info = findLlmInfo(model, LLM_INFO_PROVIDER[provider] ?? provider);
  if (info?.deprecation) {
    problems.push(
      `${provider}/${model} is deprecated (shutdown ${info.deprecation.shutdownDate})`,
    );
  }
  return problems;
}

function guiPresetIds(): [string, string][] {
  const ids: [string, string][] = [];
  for (const [key, info] of Object.entries(providers)) {
    for (const pkg of info?.packages ?? []) {
      ids.push([info?.provider ?? key, pkg.params.model]);
      for (const dimension of pkg.dimensions ?? []) {
        for (const option of Object.values(dimension.options)) {
          if (typeof option.model === "string") {
            ids.push([info?.provider ?? key, option.model]);
          }
        }
      }
    }
  }
  return ids;
}

function cliPresetIds(): [string, string][] {
  const ids: [string, string][] = [];
  const blocks = cliPresetsSource.split(
    /\n  \{\n    (?:\/\/[^\n]*\n    )*id: "/,
  );
  for (const block of blocks.slice(1)) {
    const provider = block.slice(0, block.indexOf('"'));
    const patterns = [
      /\bmodel: "([^"]+)"/g,
      /defaultModel: "([^"]+)"/g,
      /model \?\? "([^"]+)"/g,
      /customModel\(\s*"[^"]+",\s*"([^"]+)"/g,
    ];
    for (const pattern of patterns) {
      for (const match of block.matchAll(pattern)) {
        ids.push([provider, match[1]]);
      }
    }
  }
  return ids;
}

describe("model catalog", () => {
  it("isRetired compares the shutdown date with today", () => {
    const today = new Date("2026-11-04T12:00:00Z");
    expect(isRetired({}, today)).toBe(false);
    expect(isRetired(undefined, today)).toBe(false);
    expect(
      isRetired({ deprecation: { shutdownDate: "unscheduled" } }, today),
    ).toBe(false);
    expect(
      isRetired({ deprecation: { shutdownDate: "2026-12-11" } }, today),
    ).toBe(false);
    expect(
      isRetired({ deprecation: { shutdownDate: "2026-11-04" } }, today),
    ).toBe(true);
    expect(
      isRetired({ deprecation: { shutdownDate: "2026-05-15" } }, today),
    ).toBe(true);
  });

  it("llm-info has no retired models and no duplicate ids", () => {
    for (const provider of allModelProviders) {
      const ids = provider.models.map((m) => m.model);
      expect(
        ids.filter((id, i) => ids.indexOf(id) !== i),
        provider.id,
      ).toEqual([]);
      expect(ids.filter(isRetiredId), provider.id).toEqual([]);
    }
  });

  it("llm-info deprecations have a valid shutdown date", () => {
    for (const provider of allModelProviders) {
      for (const info of provider.models) {
        const date = info.deprecation?.shutdownDate;
        if (date !== undefined) {
          expect(date, `${provider.id}/${info.model}`).toMatch(
            /^(?:\d{4}-\d{2}-\d{2}|unscheduled)$/,
          );
        }
      }
    }
  });

  it("deprecated models still resolve for existing configs", () => {
    expect(findLlmInfo("gpt-4o", "openai")?.deprecation).toBeDefined();
    expect(
      findLlmInfo("claude-sonnet-4-5-20250929", "anthropic")?.deprecation
        ?.replacement,
    ).toBe("claude-sonnet-5-5");
    expect(findLlmInfo("gemini-2.5-pro", "gemini")?.deprecation).toBeDefined();
  });

  it("every provider has a first package to preselect", () => {
    for (const [key, info] of Object.entries(providers)) {
      expect(info?.packages.length, key).toBeGreaterThan(0);
    }
  });

  it("no GUI preset uses a retired or deprecated model", () => {
    expect(guiPresetIds().flatMap(([p, m]) => problemsFor(p, m))).toEqual([]);
    // Presets that aren't attached to a provider are still offered for local runtimes
    const loose = Object.values(models).flatMap((pkg) =>
      (pkg.providerOptions ?? []).map((p) => problemsFor(p, pkg.params.model)),
    );
    expect(loose.flat()).toEqual([]);
  });

  it("no onboarding default uses a retired or deprecated model", () => {
    for (const provider of ["openai", "anthropic", "gemini"]) {
      const config = setupProviderConfig(
        { name: "test", version: "1.0.0" },
        provider,
        "key",
      );
      const ids = (config.models ?? []).flatMap((m) =>
        "model" in m && m.model ? [[m.provider, m.model] as const] : [],
      );
      expect(ids.length, provider).toBeGreaterThan(0);
      expect(ids.flatMap(([p, m]) => problemsFor(p, m))).toEqual([]);
    }
  });

  it("no CLI provider preset uses a retired or deprecated model", () => {
    const ids = cliPresetIds();
    expect(ids.map(([p]) => p)).toEqual(
      expect.arrayContaining(["anthropic", "openai", "deepseek"]),
    );
    expect(ids.flatMap(([p, m]) => problemsFor(p, m))).toEqual([]);
  });
});
