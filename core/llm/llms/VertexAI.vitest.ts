import { describe, expect, it } from "vitest";

import VertexAI from "./VertexAI.js";

function vertexClaude(options: object = {}) {
  return new VertexAI({
    model: "claude-sonnet-5-5",
    region: "us-east5",
    projectId: "proj",
    env: { region: "us-east5", projectId: "proj" },
    ...options,
  });
}

describe("VertexAI", () => {
  // Chat goes through the adapter, which would cache Claude by default; a
  // project with caching turned off rejects cache_control, so core caches
  // only when the model asks, as its Anthropic class does
  it("caches Claude prompts only when the model asks for it", () => {
    const config = (llm: VertexAI) => (llm as any).adapterConfig();
    expect(config(vertexClaude()).cachingStrategy).toBe("none");
    expect(
      config(vertexClaude({ cacheBehavior: { cacheConversation: true } }))
        .cachingStrategy,
    ).toBe("systemAndTools");
    expect(
      config(vertexClaude({ cacheBehavior: { cacheSystemMessage: true } }))
        .cachingStrategy,
    ).toBe("systemAndTools");
    expect(
      config(vertexClaude({ completionOptions: { promptCaching: true } }))
        .cachingStrategy,
    ).toBe("systemAndTools");
  });
});
