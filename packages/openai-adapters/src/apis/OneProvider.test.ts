import { describe, expect, it, vi } from "vitest";

import { constructLlmApi } from "../index.js";

import { ONEPROVIDER_API_BASE, OneProviderApi } from "./OneProvider.js";

function makeApi() {
  return constructLlmApi({
    provider: "oneprovider",
    apiKey: "sk-test",
  }) as OneProviderApi;
}

describe("OneProviderApi", () => {
  it("is built by constructLlmApi", () => {
    expect(makeApi()).toBeInstanceOf(OneProviderApi);
  });

  it("uses one base URL for both APIs", () => {
    const api = makeApi() as any;
    expect(api.anthropic.apiBase).toBe(ONEPROVIDER_API_BASE);
    expect(api.openai.openai.baseURL).toBe(ONEPROVIDER_API_BASE);
  });

  it("sends the key only as x-api-key on the Anthropic API", () => {
    const headers = (makeApi() as any).anthropic.getHeaders();
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).not.toHaveProperty("authorization");
  });

  it("routes Claude to the Messages API and other models to Chat Completions", async () => {
    const api = makeApi() as any;
    const anthropic = vi
      .spyOn(api.anthropic, "chatCompletionStream")
      .mockImplementation(async function* () {});
    const openai = vi
      .spyOn(api.openai, "chatCompletionStream")
      .mockImplementation(async function* () {});
    const signal = new AbortController().signal;

    for await (const _ of api.chatCompletionStream(
      { model: "claude-sonnet-5-5", messages: [], stream: true },
      signal,
    ));
    for await (const _ of api.chatCompletionStream(
      { model: "deepseek-v4-pro", messages: [], stream: true },
      signal,
    ));

    expect(anthropic).toHaveBeenCalledTimes(1);
    expect((anthropic.mock.calls[0][0] as any).model).toBe("claude-sonnet-5-5");
    expect(openai).toHaveBeenCalledTimes(1);
    expect((openai.mock.calls[0][0] as any).model).toBe("deepseek-v4-pro");
  });
});
