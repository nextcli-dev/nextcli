import { ChatHistoryItem } from "core";
import { renderChatMessage, stripImages } from "core/util/messageContent";
import { useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import { useAppSelector } from "../../redux/hooks";
import { selectUIConfig } from "../../redux/slices/configSlice";
import { deleteMessage } from "../../redux/slices/sessionSlice";
import { AnimatedEllipsis } from "../AnimatedEllipsis";
import Spinner from "../gui/Spinner";
import ThinkingBlockPeek from "../mainInput/belowMainInput/ThinkingBlockPeek";
import StyledMarkdownPreview from "../StyledMarkdownPreview";
import { FONT_STEP, useFontSize } from "../ui/font";
import ConversationSummary from "./ConversationSummary";
import ResponseActions from "./ResponseActions";

interface StepContainerProps {
  item: ChatHistoryItem;
  index: number;
  isLast: boolean;
  latestSummaryIndex?: number;
}

export default function StepContainer(props: StepContainerProps) {
  const dispatch = useDispatch();
  const [isTruncated, setIsTruncated] = useState(false);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const uiConfig = useAppSelector(selectUIConfig);
  const rowFont = useFontSize(FONT_STEP.row);

  // Calculate dimming and indicator state based on latest summary index
  const latestSummaryIndex = props.latestSummaryIndex ?? -1;
  const isBeforeLatestSummary =
    latestSummaryIndex !== -1 && props.index <= latestSummaryIndex;
  const isLatestSummary =
    latestSummaryIndex !== -1 && props.index === latestSummaryIndex;

  const historyItemAfterThis = useAppSelector(
    (state) => state.session.history[props.index + 1],
  );
  const showResponseActions =
    (props.isLast || historyItemAfterThis?.message.role === "user") &&
    !(props.isLast && (isStreaming || props.item.toolCallStates));

  // Until the first thinking or answer text arrives the turn is an empty
  // block; reasoning models can take tens of seconds to get there
  const isWaitingForModel =
    props.isLast &&
    isStreaming &&
    !renderChatMessage(props.item.message).trim() &&
    !props.item.reasoning?.text?.trim() &&
    !props.item.toolCallStates?.length;

  useEffect(() => {
    if (!isStreaming) {
      const content = renderChatMessage(props.item.message).trim();
      const endingPunctuation = [".", "?", "!", "```", ":"];

      // If not ending in punctuation or emoji, we assume the response got truncated
      if (
        content.trim() !== "" &&
        !(
          endingPunctuation.some((p) => content.endsWith(p)) ||
          /\p{Emoji}/u.test(content.slice(-2))
        )
      ) {
        setIsTruncated(true);
      } else {
        setIsTruncated(false);
      }
    }
  }, [props.item.message.content, isStreaming]);

  function onDelete() {
    dispatch(deleteMessage(props.index));
  }

  function onContinueGeneration() {
    window.postMessage(
      {
        messageType: "userInput",
        data: {
          input: "Continue your response exactly where you left off:",
        },
      },
      "*",
    );
  }

  return (
    <div>
      <div
        className={`bg-background p-1 px-1.5 ${isBeforeLatestSummary ? "opacity-35" : ""}`}
      >
        {uiConfig?.displayRawMarkdown ? (
          <pre className="text-2xs max-w-full overflow-x-auto whitespace-pre-wrap break-words p-4">
            {renderChatMessage(props.item.message)}
          </pre>
        ) : (
          <>
            {/* Rows here cancel this block's inset (-mx-1.5) so they line up
                with the tool call rows around it */}
            {props.item.reasoning?.text?.trim() && (
              <div className="-mx-1.5">
                <ThinkingBlockPeek
                  content={props.item.reasoning.text}
                  index={props.index}
                  prevItem={props.index > 0 ? props.item : null}
                  inProgress={!props.item.reasoning?.endAt}
                  hidden={props.item.thinkingHidden}
                />
              </div>
            )}

            {isWaitingForModel && (
              <div
                className="text-description -mx-1.5 mt-1 flex items-center gap-1.5 px-4 py-1"
                style={{ fontSize: rowFont }}
                data-testid="waiting-for-model"
              >
                <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                  <Spinner />
                </span>
                <span>
                  Waiting for the model
                  <AnimatedEllipsis />
                </span>
              </div>
            )}

            <StyledMarkdownPreview
              isRenderingInStepContainer
              source={stripImages(props.item.message.content)}
              itemIndex={props.index}
            />
          </>
        )}
      </div>

      {showResponseActions && (
        <div
          className={`mt-2 h-7 transition-opacity duration-300 ease-in-out ${isBeforeLatestSummary || isStreaming ? "opacity-35" : ""} ${isStreaming && "pointer-events-none cursor-not-allowed"}`}
        >
          <ResponseActions
            isTruncated={isTruncated}
            onDelete={onDelete}
            onContinueGeneration={onContinueGeneration}
            index={props.index}
            item={props.item}
            isLast={props.isLast}
          />
        </div>
      )}

      {/* Show compaction indicator for the latest summary */}
      {isLatestSummary && (
        <div className="mx-1.5 my-5">
          <div className="flex items-center">
            <div className="border-border flex-1 border-t border-solid"></div>
            <span className="text-description mx-3 text-xs">
              Previous Conversation Compacted
            </span>
            <div className="border-border flex-1 border-t border-solid"></div>
          </div>
        </div>
      )}

      {/* ConversationSummary is outside the dimmed container so it's always at full opacity */}
      <ConversationSummary item={props.item} index={props.index} />
    </div>
  );
}
