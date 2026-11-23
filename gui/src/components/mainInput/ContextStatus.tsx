import { useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAppSelector } from "../../redux/hooks";
import { ROUTES } from "../../util/navigation";
import {
  useCanCompact,
  useCompactConversation,
} from "../../util/compactConversation";
import { ToolTip } from "../gui/Tooltip";
import HoverItem from "./InputToolbar/HoverItem";

// Theme colours for the breakdown, in segment order (system, tools, history).
// Distinct in every theme (accent and link are both blue in most), and not
// warning or error, which the ring uses for "near the limit" and "pruned".
const SEGMENT_COLORS = ["bg-description", "bg-success", "bg-link"];

function segmentColor(index: number): string {
  return SEGMENT_COLORS[index % SEGMENT_COLORS.length];
}

const CENTER = 12;
// With the 1.5 stroke, as wide as the heroicons beside it (19.5 of 24 units)
const RING_RADIUS = 9;

/** A point on the ring, `ratio` of the way round clockwise from the top */
function pointOnRing(ratio: number): { x: number; y: number } {
  const angle = ratio * 2 * Math.PI;
  return {
    x: CENTER + RING_RADIUS * Math.sin(angle),
    y: CENTER - RING_RADIUS * Math.cos(angle),
  };
}

/** The used share as a pie wedge from the top, for 0 < ratio < 1 */
function wedgePath(ratio: number): string {
  const end = pointOnRing(ratio);
  const largeArc = ratio > 0.5 ? 1 : 0;
  return `M${CENTER} ${CENTER} L${CENTER} ${CENTER - RING_RADIUS} A${RING_RADIUS} ${RING_RADIUS} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

/** 1.7K, 343.2K, 1.05M */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  }
  if (tokens >= 1000) {
    return `${Number((tokens / 1000).toFixed(1))}K`;
  }
  return String(tokens);
}

const ContextStatus = () => {
  const navigate = useNavigate();
  const contextPercentage = useAppSelector(
    (state) => state.session.contextPercentage,
  );
  const snapshot = useAppSelector((state) => state.session.contextSnapshot);
  const pruned = useAppSelector((state) => state.session.isPruned);
  const history = useAppSelector((state) => state.session.history);
  const selectedChatModel = useAppSelector(
    (state) => state.config.config.selectedModelByRole.chat?.model,
  );
  const previousHistoryLength = useRef<number | null>(null);
  const previousSelectedChatModel = useRef<string | null>(null);

  const modelChanged = useMemo(() => {
    if (!selectedChatModel) return false;
    if (previousHistoryLength.current !== history.length) {
      previousHistoryLength.current = history.length;
      previousSelectedChatModel.current = selectedChatModel;
      return false;
    }
    return previousSelectedChatModel.current !== selectedChatModel;
  }, [history.length, selectedChatModel]);

  const compactConversation = useCompactConversation();
  const canCompact = useCanCompact(history.length - 1);
  if (history.length === 0) {
    return null;
  }

  const showEmpty = !snapshot || modelChanged;
  const percentOfWindow = snapshot
    ? Math.round((snapshot.used / snapshot.window) * 100)
    : 0;
  const nearThreshold = (contextPercentage ?? 0) > 0.8;
  const colorClass = pruned
    ? "text-error"
    : nearThreshold
      ? "text-warning"
      : "text-description";
  const lastUsage = [...history]
    .reverse()
    .find((item) => item.promptLogs?.length)
    ?.promptLogs?.at(-1)?.usage;

  // Same 24-unit grid and stroke as the heroicons beside it
  const usedRatio = showEmpty
    ? 0
    : Math.min(1, snapshot.used / Math.max(snapshot.window, 1));
  const thresholdPoint = showEmpty
    ? undefined
    : pointOnRing(
        Math.min(1, snapshot.threshold.tokens / Math.max(snapshot.window, 1)),
      );

  return (
    <ToolTip
      closeEvents={{
        mouseleave: true,
        click: true,
        mouseup: false,
      }}
      clickable
      content={
        <div className="flex w-64 flex-col gap-2 text-left text-xs">
          <div className="flex items-center justify-between gap-4">
            <span className="font-semibold">Context usage</span>
            <span
              className="text-description hover:text-link cursor-pointer"
              onClick={() => navigate(ROUTES.CONTEXT)}
            >
              View report
            </span>
          </div>
          {showEmpty ? (
            <span className="text-description">
              Measured when you send the next message
            </span>
          ) : (
            <>
              <div className="flex justify-between gap-4">
                <span>{`${percentOfWindow}% full`}</span>
                <span className="text-description tabular-nums">
                  {`~${formatTokens(snapshot.used)} / ${formatTokens(snapshot.window)} tokens`}
                </span>
              </div>
              <div className="bg-border flex h-1.5 w-full gap-px overflow-hidden rounded-full">
                {snapshot.segments.map((segment, index) => (
                  <div
                    key={segment.id}
                    className={segmentColor(index)}
                    style={{
                      width: `${(segment.tokens / Math.max(snapshot.window, 1)) * 100}%`,
                    }}
                  />
                ))}
              </div>
              <div className="flex flex-col gap-1">
                {snapshot.segments.map((segment, index) => (
                  <div key={segment.id} className="flex items-center gap-2">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-sm ${segmentColor(index)}`}
                    />
                    <span className="flex-1">{segment.label}</span>
                    <span className="tabular-nums">
                      {formatTokens(segment.tokens)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="text-description flex justify-between gap-4">
                <span>Pruning starts at</span>
                <span className="tabular-nums">
                  {formatTokens(snapshot.threshold.tokens)}
                </span>
              </div>
            </>
          )}
          {lastUsage && (
            <div className="text-description flex justify-between gap-4">
              <span>Last response</span>
              <span className="tabular-nums">
                {`${formatTokens(lastUsage.promptTokens)} prompt · ${formatTokens(lastUsage.completionTokens)} output`}
              </span>
            </div>
          )}
          <span
            role="button"
            aria-disabled={!canCompact}
            className={
              canCompact
                ? "hover:text-link inline-block cursor-pointer underline"
                : "text-description-muted inline-block cursor-not-allowed"
            }
            onClick={
              canCompact
                ? () => compactConversation(history.length - 1)
                : undefined
            }
          >
            Compact now
          </span>
        </div>
      }
    >
      <HoverItem>
        <svg
          viewBox="0 0 24 24"
          // Block, so the toolbar centres the ring itself, not a text line
          className={`block h-3 w-3 hover:brightness-125 ${colorClass}`}
          aria-label="Context"
        >
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          />
          {usedRatio >= 1 ? (
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RING_RADIUS}
              fill="currentColor"
            />
          ) : (
            usedRatio > 0 && (
              <path d={wedgePath(usedRatio)} fill="currentColor" />
            )
          )}
          {thresholdPoint && (
            <circle
              cx={thresholdPoint.x}
              cy={thresholdPoint.y}
              r={1.5}
              fill="currentColor"
            />
          )}
        </svg>
      </HoverItem>
    </ToolTip>
  );
};

export default ContextStatus;
