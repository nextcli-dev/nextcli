import { Box, Text } from "ink";
import React, { memo } from "react";

import { ToolCallTitle } from "src/tools/ToolCallTitle.js";

import type { ChatHistoryItem } from "../../../../../core/index.js";
import { services } from "../../services/index.js";
import { shouldShowReasoning } from "../../util/modelSettings.js";
import { MarkdownRenderer } from "../MarkdownRenderer.js";
import { ToolResultSummary } from "../ToolResultSummary.js";

/**
 * Formats message content for display, converting message parts array back to
 * user-friendly format with placeholders like [Image #1], [Pasted Text #1], etc.
 */
function formatMessageContentForDisplay(
  content: import("../../../../../core/index.js").MessageContent,
): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return JSON.stringify(content);
  }

  // Convert message parts array back to display format with placeholders
  let displayText = "";
  let imageCounter = 0;

  for (const part of content) {
    if (part.type === "text") {
      displayText += part.text;
    } else if (part.type === "imageUrl") {
      imageCounter++;
      displayText += `[Image #${imageCounter}]`;
    } else {
      // Handle any other part types by converting to JSON
      displayText += JSON.stringify(part);
    }
  }

  return displayText;
}

interface MemoizedMessageProps {
  item: ChatHistoryItem;
  index: number;
  hideBullet?: boolean;
  /** Show the model's reasoning. Defaults to the model menu's setting */
  showReasoning?: boolean;
}

/** Off when "Show thinking" is turned off in the model menu */
export function isReasoningShown(): boolean {
  try {
    return shouldShowReasoning(services.model?.getState()?.model);
  } catch {
    return true;
  }
}

/**
 * The model's reasoning, shown dimmed above its reply. Models that return
 * only a signature (no readable text) show nothing.
 */
function ReasoningBlock({ text }: { text?: string }) {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Text color="dim" italic>
        Thinking
      </Text>
      <Text color="dim">{trimmed}</Text>
    </Box>
  );
}

export const MemoizedMessage = memo<MemoizedMessageProps>(
  ({ item, index, hideBullet = false, showReasoning }) => {
    const { message, toolCallStates, conversationSummary, reasoning } = item;
    const reasoningShown = showReasoning ?? isReasoningShown();
    const isUser = message.role === "user";
    const isSystem = message.role === "system";
    const isAssistant = message.role === "assistant";

    // Handle system messages
    if (isSystem) {
      return (
        <Box key={index} marginBottom={1}>
          <Text color="dim" italic>
            {message.content}
          </Text>
        </Box>
      );
    }

    // Handle conversation summary (compaction)
    if (conversationSummary) {
      return (
        <Box
          key={index}
          marginBottom={1}
          borderStyle="single"
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor="gray"
        />
      );
    }

    // Handle tool calls
    if (toolCallStates && toolCallStates.length > 0) {
      return (
        <Box key={index} flexDirection="column">
          {reasoningShown && <ReasoningBlock text={reasoning?.text} />}
          {/* Render assistant message content if any */}
          {message.content && (
            <Box marginBottom={1}>
              <Text color="white">{hideBullet ? " " : "●"}</Text>
              <Text> </Text>
              <MarkdownRenderer
                content={formatMessageContentForDisplay(message.content)}
              />
            </Box>
          )}

          {/* Render tool calls */}
          {toolCallStates.map((toolState) => {
            const toolName = toolState.toolCall.function.name;
            const toolArgs = toolState.parsedArgs;
            const isCompleted = toolState.status === "done";
            const isErrored =
              toolState.status === "errored" || toolState.status === "canceled";

            return (
              <Box
                key={toolState.toolCallId}
                flexDirection="column"
                marginBottom={1}
              >
                <Box width="100%">
                  <Box flexShrink={0}>
                    <Text
                      color={
                        isErrored
                          ? "red"
                          : isCompleted
                            ? "green"
                            : toolState.status === "generated"
                              ? "yellow"
                              : "white"
                      }
                    >
                      {isCompleted || isErrored ? "●" : "○"}
                    </Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text color="white">
                      {" "}
                      <ToolCallTitle toolName={toolName} args={toolArgs} />
                    </Text>
                  </Box>
                </Box>

                {isErrored ? (
                  <Box marginLeft={2}>
                    <Text color="red">
                      {toolState.output?.[0].content ?? "Tool execution failed"}
                    </Text>
                  </Box>
                ) : (
                  toolState.output &&
                  toolState.output.length > 0 && (
                    <Box marginLeft={2}>
                      <ToolResultSummary
                        toolName={toolName}
                        content={toolState.output
                          .map((o) => o.content)
                          .join("\n")}
                      />
                    </Box>
                  )
                )}
              </Box>
            );
          })}
        </Box>
      );
    }

    // Handle regular messages
    const isReasoningOnly =
      isAssistant && !message.content && !toolCallStates && !!reasoning;
    const isStreaming =
      isAssistant && !message.content && !toolCallStates && !reasoning;

    if (isReasoningOnly) {
      // A reply with only reasoning (or only a signature): no empty bullet
      return reasoningShown && reasoning.text?.trim() ? (
        <Box key={index} flexDirection="column">
          <ReasoningBlock text={reasoning.text} />
        </Box>
      ) : null;
    }

    const reply = (
      <Box key={index} marginBottom={1}>
        <Text color={isUser ? "blue" : "white"}>{hideBullet ? " " : "●"}</Text>
        <Text> </Text>
        {isUser ? (
          <Text color="dim">
            {formatMessageContentForDisplay(message.content)}
          </Text>
        ) : (
          <MarkdownRenderer
            content={formatMessageContentForDisplay(message.content)}
          />
        )}
        {isStreaming && <Text color="dim">▋</Text>}
      </Box>
    );

    if (!isAssistant || !reasoning?.text?.trim() || !reasoningShown) {
      return reply;
    }
    return (
      <Box key={index} flexDirection="column">
        <ReasoningBlock text={reasoning.text} />
        {reply}
      </Box>
    );
  },
  (prevProps, nextProps) => {
    // Custom comparison function for better performance
    // Only re-render if these properties change
    const prevMessage = prevProps.item.message;
    const nextMessage = nextProps.item.message;
    const prevToolStates = prevProps.item.toolCallStates;
    const nextToolStates = nextProps.item.toolCallStates;

    return (
      prevMessage.content === nextMessage.content &&
      prevMessage.role === nextMessage.role &&
      JSON.stringify(prevToolStates) === JSON.stringify(nextToolStates) &&
      prevProps.item.conversationSummary ===
        nextProps.item.conversationSummary &&
      prevProps.item.reasoning?.text === nextProps.item.reasoning?.text &&
      prevProps.index === nextProps.index &&
      prevProps.hideBullet === nextProps.hideBullet &&
      prevProps.showReasoning === nextProps.showReasoning
    );
  },
);

MemoizedMessage.displayName = "MemoizedMessage";
