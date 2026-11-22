import { countToolTokens } from "@nextcli/context";
import { describe, expect, it } from "vitest";

import type { MCPTool } from "../services/types.js";

import {
  convertMcpToolToContinueTool,
  convertToolToChatCompletionTool,
} from "./index.js";

const inputSchema = {
  type: "object" as const,
  properties: {
    query: { type: "string" },
  },
  required: ["query"],
  $defs: {
    Tag: { type: "string", enum: ["a", "b"] },
  },
  $ref: "#/$defs/Tag",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  examples: [{ query: "x" }],
  anyOf: [{ type: "object" }],
  oneOf: [{ type: "object" }],
  allOf: [{ type: "object" }],
  additionalProperties: false,
};

describe("MCP tool schemas", () => {
  it("sends only type, properties and required, and counts that request", () => {
    const tool = convertToolToChatCompletionTool(
      convertMcpToolToContinueTool({
        name: "search",
        description: "Search",
        inputSchema,
      } as MCPTool),
    );
    const parameters = tool.function.parameters as Record<string, unknown>;
    expect(parameters).toEqual({
      type: "object",
      properties: inputSchema.properties,
      required: ["query"],
    });

    const count = (text: string) => text.length;
    const sent = countToolTokens([tool], count).total;
    const trimmed = countToolTokens(
      [
        {
          function: {
            name: "search",
            description: "Search",
            parameters: {
              type: "object",
              properties: inputSchema.properties,
              required: inputSchema.required,
            },
          },
        },
      ],
      count,
    ).total;
    expect(sent).toBe(trimmed);
  });
});
