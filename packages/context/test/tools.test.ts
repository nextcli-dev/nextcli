import { describe, expect, it } from "vitest";

import { countToolTokens, toolSchemaText } from "../src/index.js";

const count = (text: string) => text.length;

const nested = {
  type: "object",
  properties: {
    query: {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {
            anyOf: [
              { type: "string", enum: ["a", "b"] },
              { type: "string", description: "shallow" },
            ],
          },
        },
      },
      required: ["tags"],
    },
  },
};

const search = {
  name: "search",
  description: "Look things up",
  parameters: nested,
};

describe("tool schemas", () => {
  it("counts nested properties, items, anyOf, required and array enums", () => {
    const text = toolSchemaText(search);
    expect(text).toContain("properties");
    expect(text).toContain("items");
    expect(text).toContain("anyOf");
    expect(text).toContain("required");
    expect(text).toContain('"enum":["a","b"]');

    const { total } = countToolTokens([{ function: search }], count);
    expect(total).toBe(24 + text.length);
  });

  it("changes the total when a deeply nested description changes", () => {
    const before = countToolTokens([{ function: search }], count).total;
    const deeper = {
      ...nested,
      properties: {
        query: {
          ...nested.properties.query,
          properties: {
            tags: {
              ...nested.properties.query.properties.tags,
              items: {
                anyOf: [
                  { type: "string", enum: ["a", "b"] },
                  {
                    type: "string",
                    description: "a much longer nested description",
                  },
                ],
              },
            },
          },
        },
      },
    };
    const after = countToolTokens(
      [{ function: { ...search, parameters: deeper } }],
      count,
    ).total;
    expect(after).toBeGreaterThan(before);
  });

  it("sums per-tool counts to the total minus the list overhead", () => {
    const tools = [
      { function: { name: "read", description: "Read a file" } },
      {
        function: {
          name: "search",
          description: "Search",
          parameters: nested,
        },
      },
    ];
    const { total, perTool } = countToolTokens(tools, count);
    expect(perTool).toHaveLength(2);
    expect(perTool.reduce((sum, tokens) => sum + tokens, 0)).toBe(total - 24);
    expect(perTool[0]).toBe(count(toolSchemaText(tools[0].function)));
    expect(perTool[1]).toBe(count(toolSchemaText(tools[1].function)));
  });

  it("counts an empty list as zero", () => {
    expect(countToolTokens([], count)).toEqual({ total: 0, perTool: [] });
  });
});
