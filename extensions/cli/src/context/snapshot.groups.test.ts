import type { ModelConfig } from "@nextcli/config-yaml";
import type { ContextSegment } from "@nextcli/context";
import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";
import { describe, expect, it } from "vitest";

import type { MCPConnectionInfo } from "../services/types.js";

import { cliContextSnapshot } from "./snapshot.js";

const model = {
  name: "Test",
  model: "gpt-4",
  provider: "openai",
  defaultCompletionOptions: { contextLength: 200_000, maxTokens: 4096 },
} as ModelConfig;

function tool(name: string, description: string): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: {} },
    },
  };
}

function connection(name: string, toolName: string): MCPConnectionInfo {
  return {
    config: { name },
    status: "connected",
    tools: [
      { name: toolName, description: name, inputSchema: { type: "object" } },
    ],
    prompts: [],
    warnings: [],
  } as unknown as MCPConnectionInfo;
}

function addsUp(segment: ContextSegment) {
  if (!segment.children?.length) return;
  expect(segment.children.reduce((sum, child) => sum + child.tokens, 0)).toBe(
    segment.tokens,
  );
}

describe("context snapshot groups", () => {
  it("splits same-named MCP tools by server, and parents match their children", async () => {
    const snapshot = await cliContextSnapshot({
      model,
      chatHistory: [],
      systemMessage: "You are a coding agent.",
      tools: [
        tool("search", "built-in search"),
        tool("search", "alpha search schema"),
        tool("search", "beta search schema, longer"),
      ],
      mcpConnections: [
        connection("alpha", "search"),
        connection("beta", "search"),
      ],
    });

    for (const segment of snapshot.segments) {
      addsUp(segment);
    }

    const tools = snapshot.segments.find((segment) => segment.id === "tools");
    const ids = (tools?.children ?? []).flatMap((child) => [
      child.id,
      ...(child.children?.map((nested) => nested.id) ?? []),
    ]);
    expect(ids).toContain("builtin-search");
    expect(ids).toContain("mcp-alpha-search");
    expect(ids).toContain("mcp-beta-search");
    expect(ids).toContain("tools-overhead");

    const alpha = tools?.children?.find((child) => child.id === "mcp-alpha");
    const beta = tools?.children?.find((child) => child.id === "mcp-beta");
    expect(alpha?.children?.map((child) => child.label)).toEqual(["search"]);
    expect(beta?.children?.map((child) => child.label)).toEqual(["search"]);
    expect(alpha?.tokens).not.toBe(beta?.tokens);
  });
});
