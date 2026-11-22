import { useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useStopRunGuard } from "../../hooks/useStopRunGuard";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { saveCurrentSession } from "../../redux/thunks/session";
import { ROUTES } from "../../util/navigation";
import {
  useCanCompact,
  useCompactConversation,
} from "../../util/compactConversation";
import { ToolTip } from "../gui/Tooltip";

const ContextStatus = () => {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const guardRunningTurn = useStopRunGuard();
  const contextPercentage = useAppSelector(
    (state) => state.session.contextPercentage,
  );
  const snapshot = useAppSelector((state) => state.session.contextSnapshot);
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
  const pruned = useAppSelector((state) => state.session.isPruned);
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
          <div className="flex flex-col gap-1 text-left text-xs">
            {showEmpty ? (
              <span>Measured when you send the next message</span>
            ) : (
              <span>
                {`${Math.round(snapshot.used / 1000)}K of ${Math.round(snapshot.window / 1000)}K (${percentOfWindow}%) · pruning starts at ${Math.round(snapshot.threshold.tokens / 1000)}K`}
              </span>
            )}
            {snapshot?.segments.map((segment) => (
              <span key={segment.id}>
                {`${segment.label}  ${segment.tokens}  ${segment.source}`}
              </span>
            ))}
            {lastUsage && (
              <span>
                {`Measured prompt ${lastUsage.promptTokens} · output ${lastUsage.completionTokens}`}
              </span>
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
            <span
              className="hover:text-link inline-block cursor-pointer underline"
              onClick={() => navigate(ROUTES.CONTEXT)}
            >
              View report
            </span>
            <span
              className="hover:text-link inline-block cursor-pointer underline"
              onClick={() => {
                guardRunningTurn(() =>
                  dispatch(
                    saveCurrentSession({
                      openNewSession: true,
                      generateTitle: false,
                    }),
                  ),
                );
              }}
            >
              New session
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
