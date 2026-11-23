import { useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAppSelector } from "../../redux/hooks";
import { ROUTES } from "../../util/navigation";
import {
  useCanCompact,
  useCompactConversation,
} from "../../util/compactConversation";
import { ToolTip } from "../gui/Tooltip";

// Theme colours for the breakdown, in segment order (system, tools, history)
const SEGMENT_COLORS = [
  "bg-description",
  "bg-accent",
  "bg-link",
  "bg-success",
  "bg-warning",
];

function segmentColor(index: number): string {
  return SEGMENT_COLORS[index % SEGMENT_COLORS.length];
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
  const color = pruned
    ? "var(--vscode-errorForeground, #f14c4c)"
    : nearThreshold
      ? "var(--vscode-editorWarning-foreground, #cca700)"
      : "var(--vscode-descriptionForeground, #9d9d9d)";
  const lastUsage = [...history]
    .reverse()
    .find((item) => item.promptLogs?.length)
    ?.promptLogs?.at(-1)?.usage;

  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const usedRatio = snapshot
    ? Math.min(1, snapshot.used / Math.max(snapshot.window, 1))
    : 0;
  const thresholdRatio = snapshot
    ? Math.min(1, snapshot.threshold.tokens / Math.max(snapshot.window, 1))
    : 0;

  return (
    <div>
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
        <svg width="16" height="16" viewBox="0 0 16 16" aria-label="Context">
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            opacity="0.35"
          />
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeDasharray={`${usedRatio * circumference} ${circumference}`}
            strokeLinecap="round"
            transform="rotate(-90 8 8)"
          />
          {snapshot && (
            <circle
              cx={8 + radius * Math.sin(thresholdRatio * 2 * Math.PI)}
              cy={8 - radius * Math.cos(thresholdRatio * 2 * Math.PI)}
              r="1"
              fill={color}
            />
          )}
        </svg>
      </ToolTip>
    </div>
  );
};

export default ContextStatus;
