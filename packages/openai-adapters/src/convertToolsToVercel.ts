/**
 * Converts OpenAI tool format to Vercel AI SDK format
 */

import type { ChatCompletionCreateParams } from "openai/resources/index.js";

/**
 * Ensures a top-level schema is valid for OpenAI function parameters.
 * OpenAI requires function parameters to have type: "object".
 */
function ensureValidFunctionSchema(schema: any): any {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }

  const result = { ...schema };

  if (!result.type || result.type !== "object") {
    result.type = "object";
  }

  if (!result.properties) {
    result.properties = {};
  }

  return result;
}

/**
 * Converts OpenAI tool format to Vercel AI SDK format.
 *
 * OpenAI format: { type: "function", function: { name, description, parameters: JSONSchema } }
 * Vercel format: { [toolName]: { description, inputSchema: aiJsonSchema(JSONSchema) } }
 *
 * @param openaiTools - Array of OpenAI tools or undefined
 * @returns Object with tool names as keys, or undefined if no tools
 */
export async function convertToolsToVercelFormat(
  openaiTools?: ChatCompletionCreateParams["tools"],
): Promise<Record<string, any> | undefined> {
  if (!openaiTools || openaiTools.length === 0) {
    return undefined;
  }

  const { jsonSchema: aiJsonSchema } = await import("ai");

  const vercelTools: Record<string, any> = {};
  for (const tool of openaiTools) {
    if (tool.type === "function") {
      // The schema goes as the caller wrote it, as the providers' own
      // adapters send it: making every property required would make the
      // model fill optional parameters
      vercelTools[tool.function.name] = {
        description: tool.function.description,
        inputSchema: aiJsonSchema(
          ensureValidFunctionSchema(tool.function.parameters),
        ),
        ...(tool.function.strict != null && { strict: tool.function.strict }),
      };
    }
  }

  return Object.keys(vercelTools).length > 0 ? vercelTools : undefined;
}
