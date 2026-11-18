// src/components/ThinkingBlockPeek.tsx
import { LightBulbIcon } from "@heroicons/react/24/outline";
import { ChatHistoryItem } from "core";
import { useEffect, useState } from "react";
import styled from "styled-components";

import { ToggleWithIcon } from "../../../pages/gui/ToolCallDiv/ToggleWithIcon";
import { cn } from "../../../util/cn";
import { AnimatedEllipsis } from "../../AnimatedEllipsis";
import StyledMarkdownPreview from "../../StyledMarkdownPreview";
import { FONT_STEP, useFontSize } from "../../ui/font";

const MarkdownWrapper = styled.div`
  /* The text starts under the row's label, not at the markdown's inset */
  & > div {
    padding-left: 0;
    padding-right: 0;
  }
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
 * Reasoning shown as a row like the tool call rows ("Thinking...", then
 * "Thought 17s"), with the reasoning under its label in the muted color, so
 * it reads apart from the answer. It is open while the model thinks and
 * collapses when thinking ends, unless the user opened or closed it.
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
  // The size of the tool call rows around it, not of the answer
  const rowFont = useFontSize(FONT_STEP.row);

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

  const label = inProgress ? (
    <>
      {redactedThinking ? "Redacted Thinking" : "Thinking"}
      <AnimatedEllipsis />
    </>
  ) : redactedThinking ? (
    "Redacted Thinking"
  ) : (
    "Thought" +
    (elapsedTime ? ` ${elapsedTime}` : "") +
    (tokens ? ` (${tokens} tokens)` : "")
  );

  // The layout of the tool call rows: a 16px icon column, then the label
  return duplicateRedactedThinkingBlock ? null : (
    <div className="thread-message py-1">
      <div className="mt-1 flex flex-col px-4">
        <button
          type="button"
          className={cn(
            "text-description m-0 flex min-w-0 flex-row items-center gap-1.5 border-none bg-transparent p-0 text-left transition-colors duration-200 ease-in-out [font-family:inherit]",
            hideContent
              ? "cursor-default"
              : "cursor-pointer hover:brightness-125",
          )}
          style={{ fontSize: rowFont }}
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
          <ToggleWithIcon
            icon={LightBulbIcon}
            isToggleable={!hideContent}
            open={open}
          />
          <span className="min-w-0 break-words">{label}</span>
        </button>
        {open && (
          <div
            id={`thinking-block-content-${index}`}
            data-testid="thinking-block-content"
            // Under the label: past the 16px icon and the 6px gap
            className="mt-1.5 pl-[22px]"
            style={{ fontSize: rowFont }}
          >
            {redactedThinking ? (
              <div className="text-description italic">
                Thinking content redacted due to safety reasons.
              </div>
            ) : (
              <MarkdownWrapper>
                <StyledMarkdownPreview
                  isRenderingInStepContainer
                  source={content}
                  itemIndex={index}
                  muted
                  fontSize={rowFont}
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
