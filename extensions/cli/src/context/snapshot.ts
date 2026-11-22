import type { ModelConfig } from "@nextcli/config-yaml";
import {
  buildSnapshot,
  countToolTokens,
  type ContextSegment,
  type ContextSnapshot,
} from "@nextcli/context";
import type { ChatHistoryItem } from "core/index.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";

import { services } from "../services/index.js";
import type { MCPConnectionInfo } from "../services/types.js";
import {
  countChatHistoryTokens,
  countText,
  countToolDefinitionTokens,
  historyItemParts,
  historySentToModel,
} from "../util/tokenizer.js";

const ROLE_LABELS: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  thinking: "Thinking",
};

function toolGroups(
  tools: readonly ChatCompletionTool[],
  perTool: number[],
  connections: MCPConnectionInfo[],
): ContextSegment[] {
  const serverOf = new Map<string, string>();
  for (const connection of connections) {
    for (const tool of connection.tools) {
      serverOf.set(tool.name, connection.config.name);
    }
  }

  const groups = new Map<string, ContextSegment>();
  tools.forEach((tool, index) => {
    const server = serverOf.get(tool.function.name);
    const id = server ? `mcp-${server}` : "builtin";
    const label = server ?? "Built-in";
    const child: ContextSegment = {
      id: `${id}-${tool.function.name}`,
      label: tool.function.name,
      tokens: perTool[index] ?? 0,
      source: "estimated",
    };
    const group = groups.get(id);
    if (group) {
      group.tokens += child.tokens;
      group.children?.push(child);
    } else {
      groups.set(id, {
        id,
        label,
        tokens: child.tokens,
        source: "estimated",
        children: [child],
      });
    }
  });
  return [...groups.values()];
}

/** The snapshot for a traced request, or nothing when tracing is off. */
export async function tracedContext(input: {
  model: ModelConfig;
  chatHistory: ChatHistoryItem[];
  systemMessage?: string;
  tools?: ChatCompletionTool[];
  mcpConnections?: MCPConnectionInfo[];
}): Promise<ContextSnapshot | undefined> {
  const { traceEnabled } = await import("../trace/trace.js");
  if (!traceEnabled()) {
    return undefined;
  }
  return cliContextSnapshot(input);
}

export async function cliContextSnapshot(input: {
  model: ModelConfig;
  chatHistory: ChatHistoryItem[];
  systemMessage?: string;
  tools?: ChatCompletionTool[];
  mcpConnections?: MCPConnectionInfo[];
}): Promise<ContextSnapshot> {
  const { autoCompactThreshold } = await import("../compaction.js");
  const { model, chatHistory, systemMessage, tools } = input;
  const segments: ContextSegment[] = [];

  if (systemMessage) {
    const last = services.systemMessage.lastBuilt;
    const matched = last?.text === systemMessage ? last.parts : undefined;
    const children: ContextSegment[] = matched
      ? matched.map((part) => ({
          id: part.id,
          label: part.label,
          tokens: countText(part.text),
          source: "estimated",
        }))
      : [
          {
            id: "system-prompt",
            label: "System prompt",
            tokens: countText(systemMessage),
            source: "estimated",
          },
        ];
    segments.push({
      id: "system",
      label: "System",
      tokens: countText(systemMessage) + 4,
      source: "estimated",
      children,
    });
  }

  const toolResults: { label: string; tokens: number }[] = [];
  if (tools && tools.length > 0) {
    const { total, perTool } = countToolTokens(tools, countText);
    segments.push({
      id: "tools",
      label: "Tools",
      tokens: total,
      source: "estimated",
      children: toolGroups(
        tools,
        perTool,
        input.mcpConnections ?? services.mcp.getState().connections,
      ),
    });
  }

  const byRole = new Map<string, number>();
  let reasoningTokens = 0;
  for (const item of historySentToModel(chatHistory)) {
    const parts = historyItemParts(item, model);
    byRole.set(
      parts.role,
      (byRole.get(parts.role) ?? 0) + parts.messageTokens + 3,
    );
    reasoningTokens += parts.reasoningTokens;
    toolResults.push(...parts.toolResults);
  }
  const historyChildren: ContextSegment[] = [...byRole.entries()].map(
    ([role, tokens]) => ({
      id: `history-${role}`,
      label: ROLE_LABELS[role] ?? role,
      tokens,
      source: "estimated",
    }),
  );
  if (reasoningTokens > 0) {
    historyChildren.push({
      id: "history-reasoning",
      label: "Reasoning",
      tokens: reasoningTokens,
      source: "estimated",
    });
  }
  const toolResultTokens = toolResults.reduce(
    (sum, result) => sum + result.tokens,
    0,
  );
  if (toolResultTokens > 0) {
    historyChildren.push({
      id: "history-tool-results",
      label: "Tool results",
      tokens: toolResultTokens,
      source: "estimated",
    });
  }
  segments.push({
    id: "history",
    label: "History",
    tokens: countChatHistoryTokens(chatHistory, model),
    source: "estimated",
    children: historyChildren,
  });

  const threshold = autoCompactThreshold(model);
  return buildSnapshot({
    window: threshold.contextLimit,
    threshold: {
      tokens: threshold.compactionThreshold,
      action: "auto-compaction",
      steps: [
        { label: "model context length", tokens: threshold.contextLimit },
        { label: "output reserve", tokens: -threshold.maxTokens },
        { label: "buffer", tokens: -threshold.compactionBuffer },
      ],
    },
    segments,
    toolResults,
  });
}

export async function nextRequestPrefix(model: ModelConfig): Promise<{
  systemMessage: string;
  tools: ChatCompletionTool[];
}> {
  const { requestTools } = await import("../stream/streamChatResponse.js");
  const mode = services.toolPermissions.getCurrentMode();
  const headless = services.systemMessage.getState().headless;
  const [systemMessage, tools] = await Promise.all([
    services.systemMessage.getSystemMessage(mode),
    requestTools(model, !!headless),
  ]);
  return { systemMessage, tools };
}

/** System prompt and tool tokens, the part `countChatHistoryTokens` does not include. */
export function prefixTokens(
  systemMessage: string | undefined,
  tools: ChatCompletionTool[] | undefined,
): number {
  const system = systemMessage ? countText(systemMessage) + 4 : 0;
  const tool = tools && tools.length > 0 ? countToolDefinitionTokens(tools) : 0;
  return system + tool;
}
