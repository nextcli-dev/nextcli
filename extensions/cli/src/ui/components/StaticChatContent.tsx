import type { AssistantUnrolled, ModelConfig } from "@nextcli/config-yaml";
import { Box, Static, Text, useStdout } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";

import type { ChatHistoryItem, ToolStatus } from "../../../../../core/index.js";
import type { MCPService } from "../../services/MCPService.js";
import type { QueuedMessage } from "../../stream/messageQueue.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { IntroMessage } from "../IntroMessage.js";

import { LiveRegion } from "./LiveRegion.js";

const FINISHED_TOOL_STATUSES = new Set<ToolStatus>([
  "done",
  "errored",
  "canceled",
]);

/** A tool call in the item hasn't finished, so its state can still change */
function hasUnfinishedTools(item: ChatHistoryItem | undefined): boolean {
  return !!item?.toolCallStates?.some(
    (state) => !FINISHED_TOOL_STATUSES.has(state.status),
  );
}

interface StaticChatContentProps {
  showIntroMessage: boolean;
  config?: AssistantUnrolled;
  model?: ModelConfig;
  mcpService?: MCPService;
  organizationName?: string;
  chatHistory: ChatHistoryItem[];
  queuedMessages?: QueuedMessage[];
  renderMessage: (
    item: ChatHistoryItem,
    index: number,
    allMessages?: ChatHistoryItem[],
  ) => React.ReactElement;
  refreshTrigger?: number;
  /** A response, compaction or remote session runs, so the last item can change */
  isTurnRunning?: boolean;
}

export const StaticChatContent: React.FC<StaticChatContentProps> = ({
  showIntroMessage,
  config,
  model,
  mcpService,
  organizationName,
  chatHistory,
  queuedMessages = [],
  renderMessage,
  refreshTrigger,
  isTurnRunning = false,
}) => {
  const { columns, rows } = useTerminalSize();
  const { stdout } = useStdout();

  // State for managing static refresh with key-based remounting
  const [staticKey, setStaticKey] = useState(0);
  const isInitialMount = useRef(true);

  // Refresh function that clears terminal and remounts Static component
  const refreshStatic = useCallback(() => {
    // Clear terminal completely including scrollback buffer (3J)
    stdout.write("\x1b[2J\x1b[H");
    setStaticKey((prev) => prev + 1);
    stdout.write("\x1b[3J");
  }, [stdout]);

  // Debounced terminal resize handler (300ms like gemini-cli)
  useEffect(() => {
    // Skip refreshing Static during first mount
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    // Debounce so it doesn't fire too often during resize
    const handler = setTimeout(() => {
      refreshStatic();
    }, 300);

    return () => {
      clearTimeout(handler);
    };
  }, [columns, rows, refreshStatic]);

  // Trigger refresh when refreshTrigger prop changes (for /clear command)
  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      refreshStatic();
    }
  }, [refreshTrigger, refreshStatic]);

  // Filter out system messages without content
  const processedChatHistory = React.useMemo(
    () =>
      chatHistory.filter(
        (item) => item.message.role !== "system" || item.message.content,
      ),
    [chatHistory],
  );

  // <Static> prints each item once, so an item goes there only when it can't
  // change: the last one stays live while the turn runs or a tool in it runs.
  // <Static> also prints only past the count it has seen, so the count never
  // goes down unless the history itself got shorter (edit, undo, /clear).
  const committedCount = useRef(0);
  const previousLength = useRef(0);
  const total = processedChatHistory.length;
  if (total < previousLength.current) {
    committedCount.current = 0;
  }
  previousLength.current = total;
  const keepLastLive =
    isTurnRunning || hasUnfinishedTools(processedChatHistory[total - 1]);
  const stableCount = Math.max(
    committedCount.current,
    keepLastLive ? Math.max(0, total - 1) : total,
  );
  committedCount.current = stableCount;

  const { staticItems, pendingItems } = React.useMemo(() => {
    // Add intro message as first item if it should be shown
    const staticItems: React.ReactElement[] = [];
    if (showIntroMessage) {
      staticItems.push(
        <IntroMessage
          key="intro"
          config={config}
          model={model}
          mcpService={mcpService}
          organizationName={organizationName}
        />,
      );
    }

    const stableHistory = processedChatHistory.slice(0, stableCount);
    const pendingHistory = processedChatHistory.slice(stableCount);

    // Add stable messages to static items
    stableHistory.forEach((item, index) => {
      staticItems.push(renderMessage(item, index, processedChatHistory));
    });

    // Pending items will be rendered dynamically outside Static
    const pendingItems = pendingHistory.map((item, index) =>
      renderMessage(item, stableCount + index, processedChatHistory),
    );

    return {
      staticItems,
      pendingItems,
    };
  }, [
    showIntroMessage,
    config,
    model,
    mcpService,
    organizationName,
    processedChatHistory,
    renderMessage,
    stableCount,
  ]);

  return (
    <Box flexDirection="column">
      {/* Static content - items that won't change */}
      <Static
        key={staticKey}
        items={staticItems}
        style={{
          width: columns - 1,
          textWrap: "wrap",
        }}
      >
        {(item) => item}
      </Static>

      {/* Live area - items that still change, kept below the screen height */}
      <LiveRegion>
        {pendingItems.map((item, index) => (
          <React.Fragment key={`pending-${index}`}>{item}</React.Fragment>
        ))}

        {/* Queued messages - show at bottom with queue indicators */}
        {queuedMessages.length > 0 && (
          <Box paddingLeft={2} paddingBottom={1}>
            <Text color="dim" italic>
              {queuedMessages.map((msg) => msg.message).join("\n")}
            </Text>
          </Box>
        )}
      </LiveRegion>
    </Box>
  );
};
