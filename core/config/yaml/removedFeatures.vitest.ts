/**
 * Phase 5 removed embeddings and @docs. Configs written for earlier releases
 * must still load: the `embed` role and `docs` entries are ignored with a
 * warning, never rejected.
 */
import { AssistantUnrolled } from "@nextcli/config-yaml";
import { describe, expect, it } from "vitest";

import { LLMLogger } from "../../llm/logger";
import { testIde } from "../../test/fixtures";
import {
  getBaseToolDefinitions,
  getConfigDependentToolDefinitions,
} from "../../tools";
import {
  REMOVED_DOCS_MESSAGE,
  removedEmbedRoleMessage,
} from "../loadContextProviders";
import { configYamlToContinueConfig } from "./loadYaml";

async function load(unrolledAssistant: AssistantUnrolled) {
  return configYamlToContinueConfig({
    unrolledAssistant,
    ide: testIde,
    ideInfo: await testIde.getIdeInfo(),
    uniqueId: "test",
    llmLogger: new LLMLogger(),
  });
}

describe("configs with removed features", () => {
  it("loads a model with the embed role, warns, and doesn't use it", async () => {
    const { config, errors } = await load({
      name: "old config",
      version: "1.0.0",
      models: [
        {
          name: "Chat",
          provider: "openai",
          model: "gpt-4o",
          apiKey: "x",
          roles: ["chat"],
        },
        {
          name: "Qwen3 Embedding",
          provider: "openai",
          model: "qwen3-embedding-8b",
          apiKey: "x",
          roles: ["embed"],
        },
      ],
    });

    expect(errors).toContainEqual({
      fatal: false,
      message: removedEmbedRoleMessage("Qwen3 Embedding"),
    });
    expect(errors.some((e) => e.fatal)).toBe(false);
    expect(config.modelsByRole.embed).toEqual([]);
    expect(config.selectedModelByRole.embed).toBeNull();
    expect(config.modelsByRole.chat.map((m) => m.title)).toEqual(["Chat"]);
  });

  it("loads a config with a docs block and a docs provider, with one warning each", async () => {
    const { config, errors } = await load({
      name: "old config",
      version: "1.0.0",
      context: [{ provider: "docs" }, { provider: "codebase" }],
      docs: [{ name: "JSON Lines", startUrl: "https://jsonlines.org/" }],
    });

    const docsWarnings = errors.filter(
      (e) => e.message === REMOVED_DOCS_MESSAGE,
    );
    expect(docsWarnings).toHaveLength(2);
    expect(errors.some((e) => e.fatal)).toBe(false);

    const providers = config.contextProviders.map((p) => p.description.title);
    expect(providers).toContain("codebase");
    expect(providers).not.toContain("docs");
  });

  it("does not offer the codebase tool, even with experimental tools on", async () => {
    const names = [
      ...getBaseToolDefinitions(),
      ...(await getConfigDependentToolDefinitions({
        rules: [],
        enableExperimentalTools: true,
        isRemote: false,
        modelName: undefined,
        ide: testIde,
      })),
    ].map((t) => t.function.name);

    expect(names).not.toContain("codebase");
    // The other experimental tools are still offered
    expect(names).toContain("view_repo_map");
  });
});
