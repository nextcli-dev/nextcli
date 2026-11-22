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
  anyOf: [{ type: "object" }],
  oneOf: [{ type: "object" }],
  allOf: [{ type: "object" }],
  additionalProperties: false,
};

describe("MCP tool schemas", () => {
  it("keeps root schema fields the counter reads", () => {
    const tool = convertToolToChatCompletionTool(
      convertMcpToolToContinueTool({
        name: "search",
        description: "Search",
        inputSchema,
      } as MCPTool),
    );
    const parameters = tool.function.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.properties).toEqual(inputSchema.properties);
    expect(parameters.required).toEqual(["query"]);
    expect(parameters.$defs).toEqual(inputSchema.$defs);
    expect(parameters.$ref).toBe("#/$defs/Tag");
    expect(parameters.anyOf).toEqual(inputSchema.anyOf);
    expect(parameters.oneOf).toEqual(inputSchema.oneOf);
    expect(parameters.allOf).toEqual(inputSchema.allOf);
    expect(parameters.additionalProperties).toBe(false);

    const count = (text: string) => text.length;
    const full = countToolTokens([tool], count).total;
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
    expect(full).toBeGreaterThan(trimmed);
  });
});
