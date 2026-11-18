import { ChatBubbleOvalLeftIcon } from "@heroicons/react/24/outline";
import { Editor, JSONContent } from "@tiptap/react";
import { ChatHistoryItem, InputModifiers } from "core";
import { renderChatMessage } from "core/util/messageContent";
import { memo, useCallback } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { Button, lightGray, vscBackground } from "../../components";
import TimelineItem from "../../components/gui/TimelineItem";
import ThinkingBlockPeek from "../../components/mainInput/belowMainInput/ThinkingBlockPeek";
import ContinueInputBox from "../../components/mainInput/ContinueInputBox";
import InlineErrorMessage from "../../components/mainInput/InlineErrorMessage";
import StepContainer from "../../components/StepContainer/StepContainer";
import { useAppDispatch } from "../../redux/hooks";
import {
  ChatHistoryItemWithMessageId,
  newSession,
} from "../../redux/slices/sessionSlice";
import { ToolCallDiv } from "./ToolCallDiv";

export type SendInput = (
  editorState: JSONContent,
  modifiers: InputModifiers,
  index?: number,
  editorToClearOnSend?: Editor,
) => void;

function fallbackRender({ error, resetErrorBoundary }: any) {
  // Call resetErrorBoundary() to reset the error boundary and retry the render.
  return (
    <div
      role="alert"
      className="px-2"
      style={{ backgroundColor: vscBackground }}
    >
      <p>Something went wrong:</p>
      <pre style={{ color: "red" }}>{error.message}</pre>
      <pre style={{ color: lightGray }}>{error.stack}</pre>

      <div className="text-center">
        <Button onClick={resetErrorBoundary}>Restart</Button>
      </div>
    </div>
  );
}

const noop = () => {};

interface ChatHistoryRowProps {
  item: ChatHistoryItemWithMessageId;
  index: number;
  isLast: boolean;
  /** For a user message: no user message comes after it */
  isLastUserInput: boolean;
  latestSummaryIndex: number;
  /** For a thinking message: it is the last item and the reply streams */
  inProgress: boolean;
  /** For a thinking message: the item before it */
  prevItem: ChatHistoryItem | null;
  sendInput: SendInput;
}

/**
 * One message in the chat. Memoized: while a reply streams, every other
 * message keeps the same props (items keep their identity in the store), so
 * only the streaming one renders again.
 */
export const ChatHistoryRow = memo(function ChatHistoryRow({
  item,
  index,
  isLast,
  isLastUserInput,
  latestSummaryIndex,
  inProgress,
  prevItem,
  sendInput,
}: ChatHistoryRowProps) {
  const dispatch = useAppDispatch();
  const onEnter = useCallback(
    (editorState: JSONContent, modifiers: InputModifiers) =>
      sendInput(editorState, modifiers, index),
    [sendInput, index],
  );
  const onReset = useCallback(() => {
    dispatch(newSession());
  }, [dispatch]);

  const { message, editorState, contextItems, appliedRules, toolCallStates } =
    item;
  const isBeforeLatestSummary =
    latestSummaryIndex !== -1 && index < latestSummaryIndex;

  let content: React.ReactNode = null;
  if (message.role === "user") {
    content = (
      <ContinueInputBox
        onEnter={onEnter}
        isLastUserInput={isLastUserInput}
        isMainInput={false}
        editorState={editorState ?? item.message.content}
        contextItems={contextItems}
        appliedRules={appliedRules}
        inputId={message.id}
      />
    );
  } else if (message.role === "thinking") {
    const thinkingContent = renderChatMessage(message);
    if (thinkingContent?.trim()) {
      content = (
        <div className={isBeforeLatestSummary ? "opacity-50" : ""}>
          <ThinkingBlockPeek
            content={thinkingContent}
            redactedThinking={message.redactedThinking}
            index={index}
            prevItem={prevItem}
            inProgress={inProgress}
            signature={message.signature}
            hidden={item.thinkingHidden}
          />
        </div>
      );
    }
  } else if (message.role !== "tool") {
    // Assistant messages, and anything else, render as a step
    content = (
      <>
        <div className="thread-message">
          <TimelineItem
            item={item}
            iconElement={<ChatBubbleOvalLeftIcon width="16px" height="16px" />}
            open={true}
            onToggle={noop}
          >
            <StepContainer
              index={index}
              isLast={isLast}
              item={item}
              latestSummaryIndex={latestSummaryIndex}
            />
          </TimelineItem>
        </div>
        {message.role === "assistant" && toolCallStates && (
          <ToolCallDiv toolCallStates={toolCallStates} historyIndex={index} />
        )}
      </>
    );
  }

  return (
    <div style={{ minHeight: isLast ? "200px" : 0 }}>
      <ErrorBoundary FallbackComponent={fallbackRender} onReset={onReset}>
        {content}
      </ErrorBoundary>
      {isLast && <InlineErrorMessage />}
    </div>
  );
});
