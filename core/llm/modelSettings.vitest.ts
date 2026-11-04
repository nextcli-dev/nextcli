import { describe, expect, test } from "vitest";

import type { SerializedModelControls } from "../index.js";
import Anthropic from "./llms/Anthropic.js";
import Azure from "./llms/Azure.js";
import Gemini from "./llms/Gemini.js";
import Mistral from "./llms/Mistral.js";
import Ollama from "./llms/Ollama.js";
import OpenAI from "./llms/OpenAI.js";
import xAI from "./llms/xAI.js";
import {
  modelSettingsKey,
  resolveModelSettings,
  resolveSettingsForModels,
  updateStoredModelSettings,
} from "./modelSettings.js";

function controlsFor(llm: { getModelControls(): SerializedModelControls }) {
  return llm.getModelControls();
}

const opus = new Anthropic({ apiKey: "k", model: "claude-opus-5-5" });
const sonnet46 = new Anthropic({ apiKey: "k", model: "claude-sonnet-4-6" });
const gpt = new OpenAI({ apiKey: "k", model: "gpt-5.5" });
const geminiPro = new Gemini({ apiKey: "k", model: "gemini-3.1-pro" });

describe("resolveModelSettings", () => {
  test("uses the model's defaults when nothing is chosen", () => {
    expect(
      resolveModelSettings(
        "anthropic/claude-opus-5-5",
        controlsFor(opus),
        {},
        {},
      ),
    ).toEqual({
      key: "anthropic/claude-opus-5-5",
      thinking: "shown",
      fast: false,
      contextLength: opus.contextLength,
      stored: {},
    });
    expect(
      resolveModelSettings("openai/gpt-5.5", controlsFor(gpt), {}, {}).thinking,
    ).toBe("hidden");
  });

  test("keeps thinking on by default in the IDE for Claude 4.x", () => {
    const controls = controlsFor(sonnet46);
    expect(resolveModelSettings("k", controls, {}, {}).thinking).toBe("off");
    expect(
      resolveModelSettings("k", controls, {}, {}, { thinkingOnByDefault: true })
        .thinking,
    ).toBe("shown");
  });

  test("applies stored choices and clamps the effort", () => {
    const resolved = resolveModelSettings(
      "k",
      controlsFor(sonnet46),
      {
        thinking: "hidden",
        effort: "xhigh",
        fast: true,
        contextLength: 400_000,
      },
      {},
    );
    expect(resolved).toMatchObject({
      thinking: "hidden",
      effort: "high",
      // Sonnet has no fast mode
      fast: false,
      contextLength: 400_000,
    });
  });

  test("follows the config's reasoning settings", () => {
    const controls = controlsFor(opus);
    expect(
      resolveModelSettings("k", controls, {}, { reasoning: false }).thinking,
    ).toBe("off");
    expect(
      resolveModelSettings("k", controls, {}, { reasoningEffort: "max" })
        .effort,
    ).toBe("max");
    // A menu choice wins over the config
    expect(
      resolveModelSettings(
        "k",
        controls,
        { thinking: "shown", effort: "low" },
        { reasoning: false, reasoningEffort: "max" },
      ),
    ).toMatchObject({ thinking: "shown", effort: "low" });
  });

  test("drops the effort while thinking is off where it needs thinking", () => {
    expect(
      resolveModelSettings(
        "k",
        controlsFor(gpt),
        { thinking: "off", effort: "high" },
        {},
      ).effort,
    ).toBeUndefined();
    // Claude still applies effort to the answer
    expect(
      resolveModelSettings(
        "k",
        controlsFor(opus),
        { thinking: "off", effort: "high" },
        {},
      ).effort,
    ).toBe("high");
  });

  test("ignores a thinking mode the model lacks", () => {
    expect(
      resolveModelSettings("k", controlsFor(geminiPro), { thinking: "off" }, {})
        .thinking,
    ).toBe("shown");
  });

  test("ignores a stored context window above the model's limit", () => {
    const controls = controlsFor(
      new Anthropic({ apiKey: "k", model: "claude-haiku-4-5" }),
    );
    expect(
      resolveModelSettings("k", controls, { contextLength: 1_000_000 }, {})
        .contextLength,
    ).toBe(controls.defaultContextLength);
  });
});

describe("model controls by provider", () => {
  test("offers no effort or thinking where requests ignore them", () => {
    const controls = new Ollama({
      model: "qwen3-coder:30b",
    }).getModelControls();
    expect(controls.efforts).toEqual([]);
    expect(controls.thinkingModes).toEqual([]);
    expect(controls.fast).toBe(false);
    expect(controls.contextOptions.length).toBeGreaterThan(0);
  });

  test("uses Gemini and xAI rules", () => {
    expect(controlsFor(geminiPro)).toMatchObject({
      format: "gemini",
      thinkingModes: ["hidden", "shown"],
    });
    expect(
      controlsFor(new xAI({ apiKey: "k", model: "grok-3-mini" })),
    ).toMatchObject({ format: "xai", efforts: ["low", "high"] });
  });
});

describe("stored settings", () => {
  function memoryContext() {
    let data: Record<string, unknown> = {};
    return {
      get: (key: string) => data[key],
      update: (key: string, value: unknown) => {
        data = { ...data, [key]: value };
      },
    } as any;
  }

  test("merges a change and clears settings set to null", () => {
    const gc = memoryContext();
    updateStoredModelSettings(gc, "anthropic/claude-opus-5-5", {
      effort: "high",
      fast: true,
    });
    const next = updateStoredModelSettings(gc, "anthropic/claude-opus-5-5", {
      effort: null,
      thinking: "off",
    });
    expect(next).toEqual({ fast: true, thinking: "off" });
    expect(gc.get("cliModelSettings")).toEqual({
      "anthropic/claude-opus-5-5": { fast: true, thinking: "off" },
    });
  });

  test("resolves each model once, keyed like the CLI", () => {
    const resolved = resolveSettingsForModels([opus, opus, gpt], {
      "anthropic/claude-opus-5-5": { fast: true },
    });
    expect(Object.keys(resolved)).toEqual([
      "anthropic/claude-opus-5-5",
      "openai/gpt-5.5",
    ]);
    expect(resolved["anthropic/claude-opus-5-5"].fast).toBe(true);
    expect(modelSettingsKey({ provider: "xAI", model: "grok-4" })).toBe(
      "xAI/grok-4",
    );
  });
});

describe("context length override", () => {
  test("prunes to the chosen context window", () => {
    const llm = new Anthropic({
      apiKey: "k",
      model: "claude-opus-5-5",
      contextLength: 200_000,
    });
    const long = "word ".repeat(30_000);
    const messages = [
      { role: "user" as const, content: long },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "short question" },
    ];
    expect(llm.compileChatMessages(messages, {}).didPrune).toBe(false);
    expect(
      llm.compileChatMessages(messages, { contextLength: 16_000 }).didPrune,
    ).toBe(true);
  });
});

describe("providers that only read reasoning", () => {
  test("offer thinking on or off for reasoning models", () => {
    const controls = new Ollama({ model: "deepseek-r1:8b" }).getModelControls();
    expect(controls.thinkingModes).toEqual(["off", "shown"]);
    expect(controls.thinkingUnavailable.hidden).toBeDefined();
    expect(controls.efforts).toEqual([]);
  });

  test("turn the thinking mode into reasoning", () => {
    const llm = new Ollama({ model: "deepseek-r1:8b" });
    const apply = (thinking: "off" | "shown") =>
      (llm as any).applyThinkingToReasoning({ model: llm.model, thinking });
    expect(apply("off")).toMatchObject({ reasoning: false });
    // Ollama takes no budget
    expect(apply("shown")).toMatchObject({ reasoning: true });
    expect(apply("shown").reasoningBudgetTokens).toBeUndefined();
    // Providers with model controls keep the mode as is
    expect(
      (opus as any).applyThinkingToReasoning({
        model: opus.model,
        thinking: "off",
      }),
    ).not.toHaveProperty("reasoning");
  });
});

describe("Azure OpenAI", () => {
  test("offers effort and thinking off and sends reasoning_effort", () => {
    const azure = new Azure({
      apiKey: "k",
      model: "gpt-5.5",
      apiBase: "https://example.openai.azure.com/",
      deployment: "gpt-55",
    });
    expect(azure.getModelControls()).toMatchObject({
      format: "azure",
      efforts: ["low", "medium", "high", "xhigh"],
      thinkingModes: ["off", "hidden"],
    });
    const body = (azure as any)._convertArgs(
      { model: "gpt-5.5", thinking: "off" },
      [{ role: "user", content: "Hi" }],
    );
    expect(body.reasoning_effort).toBe("none");
    const withEffort = (azure as any)._convertArgs(
      { model: "gpt-5.5", reasoningEffort: "high", thinking: "hidden" },
      [{ role: "user", content: "Hi" }],
    );
    expect(withEffort.reasoning_effort).toBe("high");
    expect(Object.keys(withEffort).some((k) => k.startsWith("nextcli_"))).toBe(
      false,
    );
  });
});

describe("generic providers", () => {
  test("show reasoning rows only for reasoning models or configured ones", () => {
    const plain = new Mistral({ apiKey: "k", model: "mistral-large-latest" });
    expect(plain.getModelControls().efforts).toEqual([]);
    const configured = new Mistral({
      apiKey: "k",
      model: "mistral-large-latest",
      completionOptions: {
        model: "mistral-large-latest",
        reasoningEffort: "high",
      },
    });
    expect(configured.getModelControls().efforts).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });
});
