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

/**
 * MCP server of each request tool. Built-ins are `undefined`.
 *
 * MCP tools are appended after built-ins, in connection order, so they match
 * from the end. A name is not a key: two servers can both expose `search`.
 */
function serverOfEachTool(
  tools: readonly ChatCompletionTool[],
  connections: MCPConnectionInfo[],
): (string | undefined)[] {
  const sequence = connections
    .filter((connection) => connection.status === "connected")
    .flatMap((connection) =>
      connection.tools.map((tool) => ({
        server: connection.config.name,
        name: tool.name,
      })),
    );
  const servers: (string | undefined)[] = new Array(tools.length);
  let toolIndex = tools.length - 1;
  for (
    let sequenceIndex = sequence.length - 1;
    sequenceIndex >= 0 && toolIndex >= 0;
    sequenceIndex--
  ) {
    const expected = sequence[sequenceIndex];
    if (!expected || tools[toolIndex]?.function.name !== expected.name) {
      continue;
    }
    servers[toolIndex] = expected.server;
    toolIndex--;
  }
  return servers;
}

function addToGroup(
  groups: Map<string, ContextSegment>,
  groupId: string,
  groupLabel: string,
  child: ContextSegment,
) {
  const group = groups.get(groupId);
  if (group?.children) {
    const taken = group.children.some((existing) => existing.id === child.id);
    if (taken) {
      child = { ...child, id: `${child.id}-${group.children.length}` };
    }
    group.tokens += child.tokens;
    group.children.push(child);
    return;
  }
  groups.set(groupId, {
    id: groupId,
    label: groupLabel,
    tokens: child.tokens,
    source: "estimated",
    children: [child],
  });
}

function toolGroups(
  tools: readonly ChatCompletionTool[],
  perTool: number[],
  connections: MCPConnectionInfo[],
): ContextSegment[] {
  const servers = serverOfEachTool(tools, connections);
  const groups = new Map<string, ContextSegment>();
  tools.forEach((tool, index) => {
    const server = servers[index];
    const groupId = server ? `mcp-${server}` : "builtin";
    const groupLabel = server ?? "Built-in";
    addToGroup(groups, groupId, groupLabel, {
      id: `${groupId}-${tool.function.name}`,
      label: tool.function.name,
      tokens: perTool[index] ?? 0,
      source: "estimated",
    });
  });
  return [...groups.values()];
}

/** Children that sum to `total`. The gap is framing the parts don't carry. */
function withRemainder(
  children: ContextSegment[],
  total: number,
  remainder: { id: string; label: string },
): ContextSegment[] {
  const sum = children.reduce((tokens, child) => tokens + child.tokens, 0);
  if (sum === total) {
    return children;
  }
  return [
    ...children,
    {
      id: remainder.id,
      label: remainder.label,
      tokens: total - sum,
      source: "estimated",
    },
  ];
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
    const systemTokens = countText(systemMessage) + 4;
    segments.push({
      id: "system",
      label: "System",
      tokens: systemTokens,
      source: "estimated",
      children: withRemainder(children, systemTokens, {
        id: "system-overhead",
        label: "Overhead",
      }),
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
      children: withRemainder(
        toolGroups(
          tools,
          perTool,
          input.mcpConnections ?? services.mcp.getState().connections,
        ),
        total,
        { id: "tools-overhead", label: "List overhead" },
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
