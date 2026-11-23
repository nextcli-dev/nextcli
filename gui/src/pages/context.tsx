import { ChevronRightIcon } from "@heroicons/react/24/outline";
import type { ChatHistoryItem, CompiledMessagesResult } from "core";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { useAppSelector } from "../redux/hooks";
import { selectContextMeasure } from "../redux/selectors/selectContextMeasure";
import { selectSelectedChatModel } from "../redux/slices/configSlice";
import {
  formatTokens,
  formatUsd,
  ModelUsage,
  responseNumber,
  segmentColor,
  sessionUsageByModel,
} from "../util/contextUsage";
import { ROUTES } from "../util/navigation";

type Snapshot = NonNullable<CompiledMessagesResult["snapshot"]>;
type Segment = Snapshot["segments"][number];

const exact = (n: number) => n.toLocaleString("en-US");
const percent = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

// Children past this many hide behind "Show all"
const TOP_CHILDREN = 5;
// Every row keeps the same bar and count columns; only the label cell
// indents. border-box: the GUI has no preflight, and a padded w-full row
// would otherwise run past the right edge.
const ROW =
  "box-border grid w-full grid-cols-[minmax(0,1fr)_4rem_4.5rem] items-center gap-2 rounded py-1 pl-0 pr-1 text-left";
const INDENT_REM = 1.25;
// Chevron box (0.875rem) plus the gap after it (0.5rem)
const LEAD_REM = 1.375;
const SECTION_TITLE =
  "text-description m-0 flex justify-between gap-3 text-xs font-semibold uppercase tracking-wide";

function ShareBar({
  part,
  whole,
  color,
}: {
  part: number;
  whole: number;
  color: string;
}) {
  const width = whole > 0 ? Math.max(1.5, (part / whole) * 100) : 0;
  return (
    <span className="bg-border block h-1 overflow-hidden rounded-full">
      <span
        className={`block h-full ${color}`}
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

function Marker({ depth, color }: { depth: number; color: string }) {
  if (depth === 0) {
    return <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${color}`} />;
  }
  if (depth === 1) {
    return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;
  }
  return null;
}

/** The label cell: indent, a fixed chevron box, the marker, the text */
function RowLabel({
  depth,
  open,
  children,
}: {
  depth: number;
  /** Undefined for a row that doesn't open */
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className="flex min-w-0 items-center gap-2"
      style={{ paddingLeft: `${depth * INDENT_REM}rem` }}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {open !== undefined && (
          <ChevronRightIcon
            className={`text-description-muted h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </span>
      {children}
    </span>
  );
}

interface BreakdownState {
  used: number;
  open: Set<string>;
  showAll: Set<string>;
  toggleOpen: (id: string) => void;
  toggleShowAll: (id: string) => void;
}

function segmentRows(
  segments: Segment[],
  depth: number,
  state: BreakdownState,
  parentColor?: string,
): JSX.Element[] {
  return segments.flatMap((segment, index) => {
    const color = parentColor ?? segmentColor(index);
    const children = segment.children ?? [];
    const isOpen = state.open.has(segment.id);
    const cells = (
      <>
        <RowLabel depth={depth} open={children.length > 0 ? isOpen : undefined}>
          <Marker depth={depth} color={color} />
          <span
            className={`truncate ${depth > 0 ? "text-description" : ""} ${segment.id.startsWith("tool-") ? "font-mono text-[0.92em]" : ""}`}
          >
            {segment.label}
          </span>
        </RowLabel>
        <ShareBar part={segment.tokens} whole={state.used} color={color} />
        <span className="text-right tabular-nums">{exact(segment.tokens)}</span>
      </>
    );
    const row =
      children.length > 0 ? (
        <button
          key={segment.id}
          className={`${ROW} hover:bg-input cursor-pointer border-0 bg-transparent text-inherit`}
          aria-expanded={isOpen}
          onClick={() => state.toggleOpen(segment.id)}
        >
          {cells}
        </button>
      ) : (
        <div key={segment.id} className={ROW}>
          {cells}
        </div>
      );
    if (!isOpen || children.length === 0) {
      return [row];
    }

    const sorted = [...children].sort((a, b) => b.tokens - a.tokens);
    const canHide = sorted.length > TOP_CHILDREN + 1;
    const showingAll = !canHide || state.showAll.has(segment.id);
    const shown = showingAll ? sorted : sorted.slice(0, TOP_CHILDREN);
    // Each part is counted alone; what joins them is the overhead
    const overhead =
      segment.tokens - children.reduce((sum, child) => sum + child.tokens, 0);
    // Under the children's text: their indent, chevron box, and dot if any
    const childTextRem =
      (depth + 1) * INDENT_REM + LEAD_REM + (depth + 1 === 1 ? 0.875 : 0);
    return [
      row,
      ...segmentRows(shown, depth + 1, state, color),
      ...(canHide
        ? [
            <button
              key={`${segment.id}-all`}
              className="text-link cursor-pointer border-0 bg-transparent py-1 pr-0 text-left hover:underline"
              style={{ paddingLeft: `${childTextRem}rem` }}
              onClick={() => state.toggleShowAll(segment.id)}
            >
              {showingAll
                ? `Show top ${TOP_CHILDREN}`
                : `Show all ${sorted.length}`}
            </button>,
          ]
        : []),
      ...(overhead > 0
        ? [
            <div key={`${segment.id}-overhead`} className={ROW}>
              <RowLabel depth={depth + 1}>
                <Marker depth={depth + 1} color={color} />
                <span className="text-description truncate">Overhead</span>
              </RowLabel>
              <ShareBar part={overhead} whole={state.used} color={color} />
              <span className="text-right tabular-nums">{exact(overhead)}</span>
            </div>,
          ]
        : []),
    ];
  });
}

function ContextTab({
  snapshot,
  history,
  isPruned,
  contextPercentage,
}: {
  snapshot: Snapshot | undefined;
  history: ChatHistoryItem[];
  isPruned: boolean;
  contextPercentage: number | undefined;
}) {
  const [open, setOpen] = useState(() => new Set(["tools", "history"]));
  const [showAll, setShowAll] = useState(() => new Set<string>());
  const toggle =
    (set: (update: (prev: Set<string>) => Set<string>) => void) =>
    (id: string) =>
      set((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });

  if (!snapshot) {
    return (
      <div className="border-border text-description rounded border border-dashed px-3 py-5 text-center">
        Measured when you send the next message.
        <br />
        <span className="text-description-muted">
          Session usage is still available.
        </span>
      </div>
    );
  }

  const near = !isPruned && (contextPercentage ?? 0) > 0.8;
  const markerColor = isPruned
    ? "bg-error"
    : near
      ? "bg-warning"
      : "bg-foreground";
  const markerPosition =
    (snapshot.threshold.tokens / Math.max(snapshot.window, 1)) * 100;
  const conversation = snapshot.segments.find((s) => s.id === "history");
  const toolResults = conversation?.children?.find(
    (c) => c.label === "Tool results",
  );
  const largest = snapshot.largestToolResults[0]?.tokens ?? 0;
  const lastUsage = [...history]
    .reverse()
    .find((item) => item.promptLogs?.length)
    ?.promptLogs?.at(-1)?.usage;
  const [windowStep, ...deductions] = snapshot.threshold.steps;

  return (
    <div className="flex flex-col gap-5">
      {near && (
        <div className="border-warning rounded border border-solid px-2.5 py-2">
          <b className="text-warning">Close to the pruning point.</b>{" "}
          {`The last request used ${percent(snapshot.used, snapshot.threshold.tokens)}% of the ${formatTokens(snapshot.threshold.tokens)} before older messages are left out, and the next one also sends its reply. Compacting replaces older messages with a summary.`}
        </div>
      )}
      {isPruned && (
        <div className="border-error rounded border border-solid px-2.5 py-2">
          <b className="text-error">Older messages were left out.</b>{" "}
          {snapshot.pruned
            ? `${snapshot.pruned.messages} messages (${formatTokens(snapshot.pruned.tokens)} tokens) didn’t fit in the last request. Compact to keep a summary of them.`
            : "Some messages didn’t fit in the last request. Compact to keep a summary of them."}
        </div>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-base font-semibold">
            {`${percent(snapshot.used, snapshot.window)}% full`}
          </span>
          <span className="text-description tabular-nums">
            {`~${formatTokens(snapshot.used)} / ${formatTokens(snapshot.window)} tokens`}
          </span>
        </div>
        <div className="relative pb-5">
          <div className="bg-border flex h-2 w-full gap-px overflow-hidden rounded-full">
            {snapshot.segments.map((segment, index) => (
              <span
                key={segment.id}
                className={`block h-full min-w-[0.125rem] ${segmentColor(index)}`}
                style={{
                  width: `${(segment.tokens / Math.max(snapshot.window, 1)) * 100}%`,
                }}
              />
            ))}
          </div>
          <span
            className={`absolute -top-0.5 h-3 w-0.5 rounded-sm ${markerColor}`}
            style={{ left: `calc(${markerPosition}% - 0.0625rem)` }}
          />
          <span
            className="text-description absolute top-3.5 -translate-x-full whitespace-nowrap text-xs tabular-nums"
            style={{ left: `${markerPosition}%` }}
          >
            {`Pruning at ${formatTokens(snapshot.threshold.tokens)}`}
          </span>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={SECTION_TITLE}>
          <span>What filled the last request</span>
          <span className="text-description-muted font-normal normal-case tracking-normal">
            tokens
          </span>
        </h3>
        <div className="flex flex-col">
          {segmentRows(snapshot.segments, 0, {
            used: snapshot.used,
            open,
            showAll,
            toggleOpen: toggle(setOpen),
            toggleShowAll: toggle(setShowAll),
          })}
        </div>
        {toolResults && percent(toolResults.tokens, snapshot.used) > 0 && (
          <p className="text-description m-0">
            {`Tool results were ${percent(toolResults.tokens, snapshot.used)}% of the last request. Compacting replaces older ones with a summary.`}
          </p>
        )}
      </section>

      {snapshot.largestToolResults.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className={SECTION_TITLE}>
            <span>Largest tool results</span>
            <span className="text-description-muted font-normal normal-case tracking-normal">
              tokens
            </span>
          </h3>
          <div className="flex flex-col">
            {snapshot.largestToolResults.map((result, index) => {
              const response = result.toolCallId
                ? responseNumber(history, result.toolCallId)
                : undefined;
              return (
                <div
                  key={`${result.toolCallId ?? result.label}-${index}`}
                  className={ROW}
                >
                  <RowLabel depth={0}>
                    <span className="min-w-0 truncate">
                      <span className="font-mono text-[0.92em]">
                        {result.label}
                      </span>
                      {response !== undefined && (
                        <span className="text-description-muted">{` · response ${response}`}</span>
                      )}
                    </span>
                  </RowLabel>
                  <ShareBar
                    part={result.tokens}
                    whole={largest}
                    color={segmentColor(2)}
                  />
                  <span className="text-right tabular-nums">
                    {exact(result.tokens)}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className={SECTION_TITLE}>
          <span>Pruning point</span>
        </h3>
        <div className="grid grid-cols-[0.875rem_minmax(0,1fr)_auto] gap-x-2 gap-y-1 tabular-nums">
          {windowStep && (
            <>
              <span />
              <span>{windowStep.label}</span>
              <span className="text-right">{exact(windowStep.tokens)}</span>
            </>
          )}
          {deductions.map((step) => (
            <div key={step.label} className="contents">
              <span className="text-description-muted text-center">
                {step.tokens < 0 ? "−" : "+"}
              </span>
              <span className="text-description">{step.label}</span>
              <span className="text-right">{exact(Math.abs(step.tokens))}</span>
            </div>
          ))}
          <span className="bg-border col-span-3 my-0.5 h-px" />
          <span className="text-description-muted text-center font-semibold">
            =
          </span>
          <span className="font-semibold">Pruning starts at</span>
          <span className="text-right font-semibold">
            {exact(snapshot.threshold.tokens)}
          </span>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={SECTION_TITLE}>
          <span>Last request</span>
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <div className="border-border flex min-w-0 flex-col gap-0.5 rounded border border-solid px-2.5 py-2">
            <span className="text-description text-xs">
              Estimated by NextCLI
            </span>
            <span className="text-base font-semibold tabular-nums">
              {exact(snapshot.used)}
            </span>
            <span className="text-description-muted text-xs">
              Before it was sent
            </span>
          </div>
          <div className="border-border flex min-w-0 flex-col gap-0.5 rounded border border-solid px-2.5 py-2">
            <span className="text-description text-xs">
              Counted by the provider
            </span>
            <span className="text-base font-semibold tabular-nums">
              {lastUsage ? exact(lastUsage.promptTokens) : "—"}
            </span>
            <span className="text-description-muted text-xs tabular-nums">
              {lastUsage
                ? `Prompt · reply ${exact(lastUsage.completionTokens)}`
                : "The provider sent no count"}
            </span>
          </div>
        </div>
        {lastUsage && (
          <p className="text-description m-0">
            {`The next request also sends this reply, about ${exact(lastUsage.completionTokens)} more tokens, plus any new tool output.`}
          </p>
        )}
      </section>
    </div>
  );
}

const PRICE_SOURCE_LABELS = {
  exact: "Exact price",
  catalog: "Catalog price",
  estimated: "Estimated price",
} as const;

function costText(model: ModelUsage): string {
  if (model.pricedRequests === 0) {
    return "Not priced";
  }
  return formatUsd(model.costUsd);
}

function SessionTab({
  history,
  inUseTitle,
}: {
  history: ChatHistoryItem[];
  inUseTitle: string | undefined;
}) {
  const [sortBy, setSortBy] = useState<"tokens" | "cost">("tokens");
  const [openModels, setOpenModels] = useState(() => new Set<string>());
  const models = useMemo(() => sessionUsageByModel(history), [history]);

  if (models.length === 0) {
    return (
      <div className="border-border text-description rounded border border-dashed px-3 py-5 text-center">
        No responses in this session yet.
      </div>
    );
  }

  const key = (m: ModelUsage) => `${m.provider}\u0000${m.modelTitle}`;
  const colorOf = new Map(models.map((m, i) => [key(m), segmentColor(i)]));
  const requests = models.reduce((sum, m) => sum + m.requests, 0);
  const input = models.reduce((sum, m) => sum + m.input, 0);
  const cached = models.reduce((sum, m) => sum + m.cached, 0);
  const output = models.reduce((sum, m) => sum + m.output, 0);
  const priced = models.reduce((sum, m) => sum + m.pricedRequests, 0);
  const cost = models.reduce((sum, m) => sum + m.costUsd, 0);
  const tokens = input + output;
  const sorted =
    sortBy === "cost"
      ? [...models].sort(
          (a, b) =>
            (b.pricedRequests ? b.costUsd : -1) -
            (a.pricedRequests ? a.costUsd : -1),
        )
      : models;
  const stat = (label: string, value: string, sub: string) => (
    <div className="border-border flex min-w-0 flex-col gap-0.5 rounded border border-solid px-2.5 py-2">
      <span className="text-description text-xs">{label}</span>
      <span className="text-base font-semibold tabular-nums">{value}</span>
      <span className="text-description-muted text-xs">{sub}</span>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stat(
          "Requests",
          exact(requests),
          `${models.length} ${models.length === 1 ? "model" : "models"}`,
        )}
        {stat(
          "Input",
          formatTokens(input),
          `${percent(cached, input)}% cached`,
        )}
        {stat("Output", formatTokens(output), "tokens")}
        {stat(
          "Cost",
          priced > 0 ? formatUsd(cost) : "—",
          priced === requests
            ? "All priced"
            : `${requests - priced} not priced`,
        )}
      </div>

      <div
        className="bg-border flex h-2 w-full gap-px overflow-hidden rounded-full"
        aria-hidden="true"
      >
        {models.map((m) => (
          <span
            key={key(m)}
            className={`block h-full ${colorOf.get(key(m))}`}
            style={{
              width: `${tokens > 0 ? ((m.input + m.output) / tokens) * 100 : 0}%`,
            }}
          />
        ))}
      </div>

      <section className="flex flex-col gap-2">
        <h3 className={SECTION_TITLE}>
          <span>By model</span>
          <span
            className="border-border inline-flex overflow-hidden rounded border border-solid font-normal normal-case tracking-normal"
            role="group"
            aria-label="Sort models"
          >
            {(["tokens", "cost"] as const).map((option) => (
              <button
                key={option}
                aria-pressed={sortBy === option}
                className={`cursor-pointer border-0 px-2 py-0.5 text-xs ${sortBy === option ? "bg-input text-foreground" : "text-description bg-transparent"}`}
                onClick={() => setSortBy(option)}
              >
                {option === "tokens" ? "Tokens" : "Cost"}
              </button>
            ))}
          </span>
        </h3>
        <div className="flex flex-col gap-2">
          {sorted.map((m) => {
            const id = key(m);
            const isOpen = openModels.has(id);
            const metric = (label: string, value: string) => (
              <span className="flex min-w-0 flex-col">
                <span className="text-description-muted text-[0.625rem] uppercase tracking-wide">
                  {label}
                </span>
                <span className="tabular-nums">{value}</span>
              </span>
            );
            return (
              <div
                key={id}
                className="border-border rounded border border-solid"
              >
                <button
                  className="hover:bg-input flex w-full cursor-pointer flex-col gap-2 border-0 bg-transparent p-2.5 text-left text-inherit"
                  aria-expanded={isOpen}
                  onClick={() =>
                    setOpenModels((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) {
                        next.delete(id);
                      } else {
                        next.add(id);
                      }
                      return next;
                    })
                  }
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className={`h-2.5 w-2.5 shrink-0 rounded-sm ${colorOf.get(id)}`}
                      />
                      <span className="truncate font-semibold">
                        {m.modelTitle}
                      </span>
                      {m.modelTitle === inUseTitle && (
                        <span className="bg-input text-description shrink-0 rounded-full px-1.5 text-[0.625rem]">
                          In use
                        </span>
                      )}
                    </span>
                    <span
                      className={`shrink-0 tabular-nums ${m.pricedRequests === 0 ? "text-description-muted" : ""}`}
                    >
                      {costText(m)}
                    </span>
                  </span>
                  <span className="grid grid-cols-4 gap-1.5">
                    {metric("Requests", exact(m.requests))}
                    {metric("Input", formatTokens(m.input))}
                    {metric("Cached", m.cached ? formatTokens(m.cached) : "—")}
                    {metric("Output", formatTokens(m.output))}
                  </span>
                </button>
                {isOpen && (
                  <div className="text-description grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 px-2.5 pb-2.5 text-xs">
                    <span>Provider</span>
                    <span className="text-foreground text-right">
                      {m.provider}
                    </span>
                    <span>Cache writes</span>
                    <span className="text-foreground text-right tabular-nums">
                      {m.cacheWrite ? exact(m.cacheWrite) : "—"}
                    </span>
                    <span>Reasoning tokens</span>
                    <span className="text-foreground text-right tabular-nums">
                      {m.reasoning ? exact(m.reasoning) : "—"}
                    </span>
                    <span>Share of session tokens</span>
                    <span className="text-foreground text-right tabular-nums">
                      {`${percent(m.input + m.output, tokens)}%`}
                    </span>
                    <span>Price</span>
                    <span className="text-foreground text-right">
                      {m.pricedRequests === 0
                        ? "Not priced"
                        : `${m.priceSources.map((s) => PRICE_SOURCE_LABELS[s]).join(", ")}${m.pricedRequests < m.requests ? ` · ${m.requests - m.pricedRequests} not priced` : ""}`}
                    </span>
                    {m.withoutUsage > 0 && (
                      <>
                        <span>Responses without a provider count</span>
                        <span className="text-foreground text-right tabular-nums">
                          {exact(m.withoutUsage)}
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <p className="text-description-muted m-0 text-xs">
        {`Counts the ${exact(requests)} chat responses saved in this session. Compaction summaries and session titles aren’t counted.`}
      </p>
    </div>
  );
}

export default function ContextPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"context" | "session">("context");
  // Empty after a change of chat model or mode, as in the ring
  const { snapshot, isPruned, contextPercentage } =
    useAppSelector(selectContextMeasure);
  const history = useAppSelector((state) => state.session.history);
  const inUseTitle = useAppSelector(selectSelectedChatModel)?.title;

  const tabButton = (id: "context" | "session", label: string) => (
    <button
      role="tab"
      aria-selected={tab === id}
      className={`-mb-px cursor-pointer border-0 border-b-2 border-solid bg-transparent px-0 pb-2 pt-2.5 ${tab === id ? "border-primary text-foreground" : "text-description hover:text-foreground border-transparent"}`}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );

  return (
    <div>
      <PageHeader title="Context" onTitleClick={() => navigate(ROUTES.HOME)} />
      <div
        className="border-border flex gap-4 border-0 border-b border-solid px-4"
        role="tablist"
      >
        {tabButton("context", "Context window")}
        {tabButton("session", "Session usage")}
      </div>
      <div className="px-4 py-4 text-sm" role="tabpanel">
        {tab === "context" ? (
          <ContextTab
            snapshot={snapshot}
            history={history}
            isPruned={isPruned}
            contextPercentage={contextPercentage}
          />
        ) : (
          <SessionTab history={history} inUseTitle={inUseTitle} />
        )}
      </div>
    </div>
  );
}
