import type { FunctionSchema } from "./types.js";

/** The tools-array wrapper both hosts already add around the schemas. */
const LIST_OVERHEAD = 24;

/**
 * JSON of the function fields a request sends. Undefined fields are omitted,
 * and nested schema fields stay inside `parameters`. A value JSON cannot
 * encode does not throw: the name is still counted.
 */
export function toolSchemaText(fn: FunctionSchema): string {
  return (
    safeJson({
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
      strict: fn.strict,
    }) ?? JSON.stringify({ name: String(fn.name) })
  );
}

function safeJson(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, current: unknown) => {
      if (typeof current === "bigint") {
        return current.toString();
      }
      if (typeof current === "object" && current !== null) {
        if (seen.has(current)) {
          return undefined;
        }
        seen.add(current);
      }
      return current;
    });
  } catch {
    return undefined;
  }
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
