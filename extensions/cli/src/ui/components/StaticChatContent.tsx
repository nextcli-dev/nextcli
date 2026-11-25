import type { AssistantUnrolled, ModelConfig } from "@nextcli/config-yaml";
import { Box, Static, Text, useStdout } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";

import type { ChatHistoryItem, ToolStatus } from "../../../../../core/index.js";
import type { MCPService } from "../../services/MCPService.js";
import type { QueuedMessage } from "../../stream/messageQueue.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { IntroMessage } from "../IntroMessage.js";

import { ClipToFit, linesWord } from "./ClipToFit.js";

const FINISHED_TOOL_STATUSES = new Set<ToolStatus>([
  "done",
  "errored",
  "canceled",
]);

/** The same message, even when the history was rebuilt with new objects */
function sameItem(
  a: ChatHistoryItem | undefined,
  b: ChatHistoryItem | undefined,
): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.message.role === b.message.role &&
      a.conversationSummary === b.conversationSummary &&
      JSON.stringify(a.message.content) === JSON.stringify(b.message.content))
  );
}

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
  /** Ctrl+L: clear the screen and print the history again, keeping scrollback */
  redrawTrigger?: number;
  /** A response or compaction runs, so the last item can change */
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
  redrawTrigger,
  isTurnRunning = false,
}) => {
  const { columns, rows } = useTerminalSize();
  const { stdout } = useStdout();

  // State for managing static refresh with key-based remounting
  const [staticKey, setStaticKey] = useState(0);
  const isInitialMount = useRef(true);
  // <Static> items printed before a compaction replaced the history
  const printedSlots = useRef(0);

  // Refresh function that clears terminal and remounts Static component.
  // A resize or /clear also erases the scrollback (3J), where the old copy
  // of the history sits; Ctrl+L keeps it, as a shell's clear-screen does.
  const refreshStatic = useCallback(
    (keepScrollback = false) => {
      stdout.write("\x1b[2J\x1b[H");
      // The remounted <Static> prints the whole history again
      printedSlots.current = 0;
      setStaticKey((prev) => prev + 1);
      if (!keepScrollback) {
        stdout.write("\x1b[3J");
      }
    },
    [stdout],
  );

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

  // Ctrl+L
  useEffect(() => {
    if (redrawTrigger !== undefined && redrawTrigger > 0) {
      refreshStatic(true);
    }
  }, [redrawTrigger, refreshStatic]);

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
  // goes down unless the history itself got shorter (compaction, edit, undo,
  // /clear, Escape dropping the live reply).
  const committedCount = useRef(0);
  const previousLength = useRef(0);
  const total = processedChatHistory.length;
  const shrank = total < previousLength.current;
  if (shrank) {
    committedCount.current = 0;
  }
  previousLength.current = total;

  // A compaction replaces the printed history with a shorter one that starts
  // with its summary. Nothing is cleared: the new history prints below the
  // turns already on screen, after as many empty slots as <Static> printed,
  // since it only prints past that count. Edit, undo and /clear redraw the
  // screen themselves (refreshTrigger); a shrink that keeps the first item
  // (Escape dropping the live reply) has nothing to print again.
  const firstItem = useRef<ChatHistoryItem | undefined>(undefined);
  const printedLength = useRef(0);
  if (shrank && !sameItem(processedChatHistory[0], firstItem.current)) {
    printedSlots.current = printedLength.current;
  }
  firstItem.current = processedChatHistory[0];
  const slots = printedSlots.current;
  const keepLastLive =
    isTurnRunning || hasUnfinishedTools(processedChatHistory[total - 1]);
  const stableCount = Math.max(
    committedCount.current,
    keepLastLive ? Math.max(0, total - 1) : total,
  );
  committedCount.current = stableCount;

  const { staticItems, pendingItems } = React.useMemo(() => {
    // After a compaction, empty slots for what <Static> already printed (the
    // intro included); otherwise the intro, if it should be shown
    const staticItems: React.ReactElement[] = Array.from(
      { length: slots },
      (_, i) => <React.Fragment key={`printed-${i}`} />,
    );
    if (slots === 0 && showIntroMessage) {
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
    slots,
  ]);
  printedLength.current = staticItems.length;

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
      <ClipToFit
        keep="end"
        note={(hidden) =>
          `↑ ${linesWord(hidden)}, shown in full when this step finishes`
        }
      >
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
      </ClipToFit>
    </Box>
  );
};
