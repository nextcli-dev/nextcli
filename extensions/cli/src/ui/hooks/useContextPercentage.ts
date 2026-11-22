import { ModelConfig } from "@nextcli/config-yaml";
import type { ChatHistoryItem } from "core/index.js";
import { useEffect, useRef, useState } from "react";

import { autoCompactThreshold } from "../../compaction.js";
import { nextRequestPrefix, prefixTokens } from "../../context/snapshot.js";
import type { PermissionMode } from "../../permissions/types.js";
import { services } from "../../services/index.js";
import { countChatHistoryTokens } from "../../util/tokenizer.js";

interface UseContextPercentageProps {
  chatHistory: ChatHistoryItem[];
  model?: ModelConfig;
  mode: PermissionMode;
  isRemoteMode: boolean;
  isStreaming: boolean;
}

export interface ContextUsage {
  used: number;
  window: number;
  /** Percentage of the window, 0–100 */
  percentage: number;
  /** At least 80% of the compaction threshold */
  nearThreshold: boolean;
}

/**
 * Identity of the history ignoring the streaming answer's text. Token chunks
 * grow that text in place. Tool results, tool calls and compaction change
 * this, and those are what the compaction check reads.
 */
function historyShape(history: ChatHistoryItem[]): string {
  return history
    .map((item) => {
      const message = item.message;
      const summary = item.conversationSummary?.length ?? 0;
      let marker = "";
      if (message.role === "tool") {
        const size =
          typeof message.content === "string" ? message.content.length : "p";
        marker = `${message.toolCallId}:${size}`;
      } else if (message.role === "assistant") {
        marker = (message.toolCalls ?? [])
          .map((call) => call.id ?? "")
          .join(",");
      } else if (typeof message.content === "string") {
        marker = String(message.content.length);
      }
      return `${message.role}:${summary}:${marker}`;
    })
    .join("\n");
}

/** Connected MCP servers and their tools, so a new schema moves the bar. */
function mcpToolsKey(): string {
  const connections = services.mcp?.getState()?.connections ?? [];
  return connections
    .map(
      (connection) =>
        `${connection.status}:${connection.config.name}:${connection.tools
          .map((tool) => tool.name)
          .join(",")}`,
    )
    .join("|");
}

/**
 * The estimate the compaction trigger compares. Token chunks of the answer
 * in progress keep the last value. A tool result, a compaction, a new MCP
 * server, or a model or mode change recomputes it.
 */
export function useContextPercentage({
  chatHistory,
  model,
  mode,
  isRemoteMode,
  isStreaming,
}: UseContextPercentageProps): ContextUsage | null {
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const [mcpKey, setMcpKey] = useState(mcpToolsKey);
  const previous = useRef({
    mode,
    model,
    streaming: false,
    mcp: mcpKey,
    shape: "",
  });
  // Bumped only when a new count starts, so a token chunk does not cancel
  // the count that began the turn
  const generation = useRef(0);

  useEffect(() => {
    const svc = services.mcp;
    if (!svc) {
      return;
    }
    const sync = () => setMcpKey(mcpToolsKey());
    svc.on("stateChanged", sync);
    return () => {
      svc.off("stateChanged", sync);
    };
  }, []);

  useEffect(() => {
    if (isRemoteMode || !model) {
      generation.current += 1;
      setUsage(null);
      return;
    }

    const started = isStreaming && !previous.current.streaming;
    const settingsChanged =
      previous.current.mode !== mode || previous.current.model !== model;
    const mcpChanged = previous.current.mcp !== mcpKey;
    const shape = historyShape(chatHistory);
    const historyChanged = previous.current.shape !== shape;
    previous.current = {
      mode,
      model,
      streaming: isStreaming,
      mcp: mcpKey,
      shape,
    };
    if (
      isStreaming &&
      !started &&
      !settingsChanged &&
      !mcpChanged &&
      !historyChanged
    ) {
      return;
    }

    const gen = ++generation.current;
    void nextRequestPrefix(model)
      .then(({ systemMessage, tools }) => {
        if (generation.current !== gen) {
          return;
        }
        const used =
          prefixTokens(systemMessage, tools) +
          countChatHistoryTokens(chatHistory, model);
        const threshold = autoCompactThreshold(model);
        const percentage =
          threshold.contextLimit > 0
            ? Math.min(100, Math.round((used / threshold.contextLimit) * 100))
            : 0;
        setUsage({
          used,
          window: threshold.contextLimit,
          percentage,
          nearThreshold:
            threshold.compactionThreshold > 0 &&
            used >= 0.8 * threshold.compactionThreshold,
        });
      })
      .catch(() => {
        // The bar keeps its last value. The rejection must not go unhandled.
      });
  }, [chatHistory, model, mode, isRemoteMode, isStreaming, mcpKey]);

  return usage;
}
