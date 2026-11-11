// src/components/ThinkingBlockPeek.tsx
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { ChatHistoryItem } from "core";
import { useEffect, useState } from "react";
import styled from "styled-components";

import { AnimatedEllipsis } from "../../AnimatedEllipsis";
import StyledMarkdownPreview from "../../StyledMarkdownPreview";
import { getFontSize } from "../../../util";

const MarkdownWrapper = styled.div`
  & > div > *:first-child {
    margin-top: 0 !important;
  }
  /* A little looser than answers, as reasoning is read as running prose */
  & p,
  & li {
    line-height: 1.6;
  }
`;

interface ThinkingBlockPeekProps {
  content: string;
  redactedThinking?: string;
  index: number;
  prevItem: ChatHistoryItem | null;
  inProgress?: boolean;
  signature?: string;
  tokens?: number;
  /** The Thinking mode was Hidden when this block streamed */
  hidden?: boolean;
}

/**
 * Reasoning shown as a quiet text row ("Thinking...", then "Thought 17s")
 * with the reasoning below it in the muted color, so it reads apart from the
 * answer. It is open while the model thinks and collapses when thinking
 * ends, unless the user opened or closed it.
 */
function ThinkingBlockPeek({
  content,
  redactedThinking,
  index,
  prevItem,
  inProgress,
  tokens,
  hidden,
}: ThinkingBlockPeekProps) {
  // undefined until the user toggles, so the block follows inProgress;
  // after a toggle it keeps the user's choice
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
  // Thinking was Hidden when this streamed: show that the model thought,
  // not what. Judged per block, so changing models doesn't change it
  const hideContent = !!hidden;
  const open = !hideContent && (userOpen ?? !!inProgress);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState<string>("");

  const duplicateRedactedThinkingBlock =
    prevItem &&
    prevItem.message.role === "thinking" &&
    redactedThinking &&
    prevItem.message.redactedThinking;

  useEffect(() => {
    if (inProgress) {
      setStartTime(Date.now());
      setElapsedTime("");
    } else if (startTime) {
      const seconds = Math.max(1, Math.round((Date.now() - startTime) / 1000));
      setElapsedTime(`${seconds}s`);
    }
  }, [inProgress]);

  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  return duplicateRedactedThinkingBlock ? null : (
    <div className="thread-message">
      <div className="mt-1 flex flex-col px-4">
        <div>
          <button
            type="button"
            className={`text-description m-0 mb-1.5 flex min-w-0 flex-row items-center gap-1 border-none bg-transparent py-0 pl-2 pr-0 transition-colors duration-200 ease-in-out ${
              hideContent
                ? "cursor-default"
                : "cursor-pointer hover:brightness-150"
            }`}
            style={{ fontSize: getFontSize() }}
            data-testid="thinking-block-peek"
            aria-expanded={hideContent ? undefined : open}
            aria-controls={
              hideContent ? undefined : `thinking-block-content-${index}`
            }
            title={
              hideContent
                ? "Thinking is hidden. Change it in the model menu."
                : undefined
            }
            onClick={() => !hideContent && setUserOpen(!open)}
          >
            {inProgress ? (
              <span>
                {redactedThinking ? "Redacted Thinking" : "Thinking"}
                <AnimatedEllipsis />
              </span>
            ) : redactedThinking ? (
              "Redacted Thinking"
            ) : (
              "Thought" +
              (elapsedTime ? ` ${elapsedTime}` : "") +
              (tokens ? ` (${tokens} tokens)` : "")
            )}
            {hideContent ? null : <Chevron className="h-3.5 w-3.5" />}
          </button>
        </div>
        {open && (
          <div
            id={`thinking-block-content-${index}`}
            data-testid="thinking-block-content"
            className="mb-2"
          >
            {redactedThinking ? (
              <div className="text-description pl-2 italic">
                Thinking content redacted due to safety reasons.
              </div>
            ) : (
              <MarkdownWrapper>
                <StyledMarkdownPreview
                  isRenderingInStepContainer
                  source={content}
                  itemIndex={index}
                  muted
                />
              </MarkdownWrapper>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ThinkingBlockPeek;
