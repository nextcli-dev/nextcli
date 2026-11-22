import type { FunctionSchema } from "./types.js";

/** The tools-array wrapper both hosts already add around the schemas. */
const LIST_OVERHEAD = 24;

/** JSON of `{ name, description, parameters }`, so nested fields all count. */
export function toolSchemaText(fn: FunctionSchema): string {
  return JSON.stringify({
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters,
  });
}

/**
 * `0` for an empty list. Otherwise the list overhead plus each schema
 * counted on its own, so `perTool` sums to `total` minus that overhead.
 */
export function countToolTokens(
  tools: readonly { function: FunctionSchema }[],
  count: (text: string) => number,
): { total: number; perTool: number[] } {
  if (tools.length === 0) {
    return { total: 0, perTool: [] };
  }

  const perTool = tools.map((tool) => count(toolSchemaText(tool.function)));
  const total =
    LIST_OVERHEAD + perTool.reduce((sum, tokens) => sum + tokens, 0);
  return { total, perTool };
}
