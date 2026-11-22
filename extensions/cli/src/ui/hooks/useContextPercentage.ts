import { ModelConfig } from "@nextcli/config-yaml";
import type { ChatHistoryItem } from "core/index.js";
import { useEffect, useRef, useState } from "react";

import { autoCompactThreshold } from "../../compaction.js";
import { nextRequestPrefix, prefixTokens } from "../../context/snapshot.js";
import type { PermissionMode } from "../../permissions/types.js";
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
 * The estimate the compaction trigger compares. It keeps the last value
 * while a response streams, and recomputes when a response starts or ends
 * or the model or mode changes.
 */
export function useContextPercentage({
  chatHistory,
  model,
  mode,
  isRemoteMode,
  isStreaming,
}: UseContextPercentageProps): ContextUsage | null {
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const previous = useRef({ mode, model, streaming: false });

  useEffect(() => {
    if (isRemoteMode || !model) {
      setUsage(null);
      return;
    }

    const started = isStreaming && !previous.current.streaming;
    const settingsChanged =
      previous.current.mode !== mode || previous.current.model !== model;
    previous.current = { mode, model, streaming: isStreaming };
    if (isStreaming && !started && !settingsChanged) {
      return;
    }

    let cancelled = false;
    void nextRequestPrefix(model).then(({ systemMessage, tools }) => {
      if (cancelled) {
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
    });

    return () => {
      cancelled = true;
    };
  }, [chatHistory, model, mode, isRemoteMode, isStreaming]);

  return usage;
}
