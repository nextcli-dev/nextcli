import { afterEach, describe, expect, it } from "vitest";

import { AiSdkApi } from "../apis/AiSdk.js";
import { OpenAIApi } from "../apis/OpenAI.js";
import { constructLlmApi } from "../index.js";

const NAMES = ["NEXTCLI_USE_AI_SDK", "CONTINUE_USE_AI_SDK"];
const saved = Object.fromEntries(
  NAMES.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
});

function setEnv(vars: Record<string, string>) {
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, vars);
}

function openai() {
  return constructLlmApi({
    provider: "openai",
    apiKey: "k",
    model: "gpt-5.5",
  } as any);
}

describe("NEXTCLI_USE_AI_SDK", () => {
  it("routes OpenAI through the AI SDK", () => {
    setEnv({ NEXTCLI_USE_AI_SDK: "1" });
    expect(openai()).toBeInstanceOf(AiSdkApi);
  });

  it("still reads the old name, CONTINUE_USE_AI_SDK", () => {
    setEnv({ CONTINUE_USE_AI_SDK: "1" });
    expect(openai()).toBeInstanceOf(AiSdkApi);
  });

  it("lets the new name win when both are set", () => {
    setEnv({ NEXTCLI_USE_AI_SDK: "", CONTINUE_USE_AI_SDK: "1" });
    expect(openai()).toBeInstanceOf(OpenAIApi);
  });

  it("keeps the usual adapter when neither is set", () => {
    setEnv({});
    expect(openai()).toBeInstanceOf(OpenAIApi);
  });
});
