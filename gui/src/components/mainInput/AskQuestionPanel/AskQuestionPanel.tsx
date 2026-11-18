import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  QuestionMarkCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  AnswerSet,
  draftsToAnswerSet,
  firstUnanswered,
  isDraftAnswered,
  normalizeQuestionArgs,
  pickOption,
  QuestionDraft,
  QuestionSet,
  skipDraft,
  typeOther,
} from "@nextcli/ask-question";
import { ToolCallState } from "core";
import {
  ComponentType,
  FocusEvent,
  KeyboardEvent,
  ReactNode,
  SVGProps,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppDispatch } from "../../../redux/hooks";
import {
  dismissQuestion,
  submitQuestionAnswers,
} from "../../../redux/thunks/answerQuestion";
import { getMetaKeyLabel, isMetaEquivalentKeyPressed } from "../../../util";
import {
  loadQuestionDraft,
  PanelDraft,
  saveQuestionDraft,
} from "../../../util/askQuestionDrafts";
import { cn } from "../../../util/cn";
import { Button } from "../../ui/Button";
import { FONT_STEP, useFontSize } from "../../ui/font";
import { useMainEditor } from "../TipTapEditor/MainEditorProvider";
import { ChoiceBadge, OptionRow } from "./OptionRow";

const PANEL_CLASS =
  "bg-input text-input-foreground border-command-border focus-within:border-command-border-focus rounded-default flex flex-col gap-1.5 border border-solid px-2 pb-1.5 pt-2 outline-none";

/** Highest option a number key can pick. */
const MAX_NUMBER_KEY = 9;

function replaceAt<T>(list: T[], index: number, value: T): T[] {
  return list.map((item, i) => (i === index ? value : item));
}

function Kbd({ children }: { children: ReactNode }) {
  return <span className="ml-1 opacity-75">{children}</span>;
}

function IconButton({
  icon: Icon,
  label,
  title,
  disabled,
  onClick,
  testId,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className="text-description hover:enabled:bg-list-hover hover:enabled:text-foreground flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 disabled:cursor-default disabled:opacity-40"
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}

/**
 * The questions from an ask_question call, shown in place of the chat input.
 * Answering continues the turn; dismissing ends it and gives the input back.
 */
export function AskQuestionPanel({
  toolCallState,
}: {
  toolCallState: ToolCallState;
}) {
  const set = useMemo(() => {
    try {
      return normalizeQuestionArgs(toolCallState.parsedArgs);
    } catch {
      return undefined;
    }
  }, [toolCallState.parsedArgs]);

  if (!set) {
    return <UnreadableQuestion toolCallId={toolCallState.toolCallId} />;
  }
  return <QuestionForm toolCallId={toolCallState.toolCallId} set={set} />;
}

/** core validated the arguments, so this only shows if the two disagree. */
function UnreadableQuestion({ toolCallId }: { toolCallId: string }) {
  const dispatch = useAppDispatch();
  const rowFont = useFontSize(FONT_STEP.row);
  const controlFont = useFontSize(FONT_STEP.control);
  return (
    <div
      className={PANEL_CLASS}
      style={{ fontSize: rowFont }}
      data-testid="ask-question-panel"
    >
      <span className="text-description" style={{ fontSize: controlFont }}>
        NextCLI sent a question this panel can't show.
      </span>
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          className="my-0"
          onClick={() => void dispatch(dismissQuestion({ toolCallId }))}
          data-testid="ask-question-dismiss"
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function QuestionForm({
  toolCallId,
  set,
}: {
  toolCallId: string;
  set: QuestionSet;
}) {
  const dispatch = useAppDispatch();
  const { mainEditor } = useMainEditor();
  // Question and options at the size of the chat's tool call rows
  const rowFont = useFontSize(FONT_STEP.row);
  const controlFont = useFontSize(FONT_STEP.control);
  const captionFont = useFontSize(FONT_STEP.caption);
  const [draft, setDraft] = useState<PanelDraft>(() =>
    loadQuestionDraft(toolCallId, set.questions.length),
  );
  const [warning, setWarning] = useState("");
  const [hasFocus, setHasFocus] = useState(false);
  const [focusTarget, setFocusTarget] = useState<"panel" | "other" | null>(
    "panel",
  );
  const finished = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  const total = set.questions.length;
  const page = draft.page;
  const question = set.questions[page];
  const current = draft.drafts[page];
  const optionCount = question.options.length;
  const highlight = draft.highlight[page] ?? 0;
  const isLast = page === total - 1;
  const answered = isDraftAnswered(question, current);
  // One single-choice question: picking an option is the whole answer.
  const sendsOnPick = total === 1 && !question.multiSelect && optionCount > 0;

  useEffect(() => {
    if (!finished.current) saveQuestionDraft(toolCallId, draft);
  }, [toolCallId, draft]);

  // The editor grabs focus when streaming stops, which is exactly when the
  // panel appears, so focus is moved after the next paint.
  useEffect(() => {
    if (!focusTarget) return;
    const frame = requestAnimationFrame(() => {
      const other = otherRef.current;
      if ((focusTarget === "other" || optionCount === 0) && other) {
        other.focus({ preventScroll: true });
        other.setSelectionRange(other.value.length, other.value.length);
      } else {
        panelRef.current?.focus({ preventScroll: true });
      }
      setFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTarget, optionCount, page]);

  function finish(answers: AnswerSet) {
    if (finished.current) return;
    finished.current = true;
    void dispatch(
      answers.dismissed
        ? dismissQuestion({ toolCallId })
        : submitQuestionAnswers({ toolCallId, answers }),
    );
    requestAnimationFrame(() => mainEditor?.commands.focus());
  }

  function withCurrent(next: QuestionDraft, nextHighlight = highlight) {
    return {
      ...draft,
      drafts: replaceAt(draft.drafts, page, next),
      highlight: replaceAt(draft.highlight, page, nextHighlight),
    };
  }

  /** Moves on from the current question, or sends when it is the last one. */
  function advance(next: PanelDraft) {
    setWarning("");
    if (next.page < total - 1) {
      setDraft({ ...next, page: next.page + 1 });
      setFocusTarget("panel");
      return;
    }
    const missing = firstUnanswered(set, next.drafts);
    if (missing >= 0) {
      setDraft({ ...next, page: missing });
      setWarning(`Answer or skip question ${missing + 1} first.`);
      setFocusTarget("panel");
      return;
    }
    setDraft(next);
    finish(draftsToAnswerSet(set, next.drafts));
  }

  function goNext() {
    if (!answered) {
      setWarning(
        optionCount === 0
          ? "Type an answer, or press Esc to skip."
          : question.multiSelect
            ? "Pick at least one option, or press Esc to skip."
            : "Pick an option, or press Esc to skip.",
      );
      return;
    }
    advance(draft);
  }

  function skip() {
    advance(withCurrent(skipDraft()));
  }

  function pick(index: number, thenAdvance: boolean) {
    const next = withCurrent(pickOption(question, current, index), index);
    setWarning("");
    if (thenAdvance) {
      advance(next);
    } else {
      setDraft(next);
    }
  }

  function setOther(text: string) {
    setWarning("");
    setDraft(withCurrent(typeOther(question, current, text), optionCount));
  }

  function goPage(delta: number) {
    const next = page + delta;
    if (next < 0 || next >= total) return;
    setWarning("");
    setDraft({ ...draft, page: next });
    setFocusTarget("panel");
  }

  function moveHighlight(delta: number) {
    const next = Math.max(0, Math.min(optionCount, highlight + delta));
    setDraft(withCurrent(current, next));
    setFocusTarget(next === optionCount ? "other" : "panel");
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.nativeEvent.isComposing || finished.current) return;
    const target = e.target as HTMLElement;
    const inText = target.matches("input, textarea");
    const anyMod = e.metaKey || e.ctrlKey;

    // The Lump accepts or rejects a pending tool call on these keys, from a
    // document listener. Keep them in the panel.
    if (anyMod && (e.key === "Backspace" || e.key === "Enter")) {
      e.stopPropagation();
      if (!isMetaEquivalentKeyPressed(e)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        goNext();
      } else if (!inText) {
        e.preventDefault();
        finish({ dismissed: true });
      }
      return;
    }
    if (target.closest("button") && (e.key === "Enter" || e.key === " ")) {
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (inText && optionCount > 0) {
        setDraft(withCurrent(current, optionCount));
        setFocusTarget("panel");
      } else {
        skip();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !anyMod) {
      e.preventDefault();
      if (inText || optionCount === 0 || question.multiSelect) {
        goNext();
      } else if (highlight < optionCount) {
        pick(highlight, true);
      } else {
        setFocusTarget("other");
      }
      return;
    }
    if (inText) {
      const field = target as HTMLInputElement;
      if (
        e.key === "ArrowUp" &&
        optionCount > 0 &&
        field.selectionStart === 0 &&
        field.selectionEnd === 0
      ) {
        e.preventDefault();
        setDraft(withCurrent(current, optionCount - 1));
        setFocusTarget("panel");
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveHighlight(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      goPage(e.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      if (highlight < optionCount) {
        pick(highlight, false);
      } else {
        setFocusTarget("other");
      }
      return;
    }
    if (anyMod || e.altKey || e.key.length !== 1) return;
    const number = Number(e.key);
    if (Number.isInteger(number) && number >= 1 && number <= MAX_NUMBER_KEY) {
      if (number <= optionCount) {
        e.preventDefault();
        pick(number - 1, false);
      }
      return;
    }
    if (optionCount > 0) {
      // Typing anywhere in the panel writes the "Other" answer.
      e.preventDefault();
      setOther(current.other + e.key);
      setFocusTarget("other");
    }
  }

  function onBlur(e: FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setHasFocus(false);
    }
  }

  const questionId = `ask-question-text-${toolCallId}`;
  const otherSelected = current.otherOn && current.other.trim() !== "";
  const keyHint =
    optionCount > 0
      ? `↑↓ move · 1–${Math.min(optionCount, MAX_NUMBER_KEY)} pick${question.multiSelect ? " · Space toggle" : ""}`
      : "Shift+⏎ new line";

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-label="Questions from NextCLI"
      data-testid="ask-question-panel"
      className={PANEL_CLASS}
      style={{ fontSize: rowFont }}
      onKeyDown={onKeyDown}
      onFocus={() => setHasFocus(true)}
      onBlur={onBlur}
    >
      <div
        className="text-description flex min-h-5 items-center gap-1.5"
        style={{ fontSize: controlFont }}
      >
        <QuestionMarkCircleIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">Questions</span>
        {question.header && (
          <span
            title={question.header}
            className="bg-badge text-badge-foreground max-w-[12ch] truncate rounded px-1.5"
            style={{ fontSize: captionFont }}
          >
            {question.header}
          </span>
        )}
        <span className="flex-1" />
        {total > 1 && (
          <div className="flex items-center tabular-nums">
            <IconButton
              icon={ChevronLeftIcon}
              label="Previous question"
              disabled={page === 0}
              onClick={() => goPage(-1)}
              testId="ask-question-previous"
            />
            <span
              className="whitespace-nowrap px-1"
              data-testid="ask-question-count"
            >
              {page + 1} of {total}
            </span>
            <IconButton
              icon={ChevronRightIcon}
              label="Next question"
              disabled={isLast}
              onClick={() => goPage(1)}
              testId="ask-question-following"
            />
          </div>
        )}
        <IconButton
          icon={XMarkIcon}
          label="Dismiss all questions"
          title={`Dismiss all (${getMetaKeyLabel()}⌫)`}
          onClick={() => finish({ dismissed: true })}
          testId="ask-question-dismiss"
        />
      </div>

      <p
        id={questionId}
        className="m-0 whitespace-pre-wrap break-words font-semibold"
        data-testid="ask-question-text"
      >
        {question.question}
      </p>
      {question.multiSelect && (
        <p className="text-description m-0" style={{ fontSize: controlFont }}>
          Select all that apply.
        </p>
      )}

      <div
        role={question.multiSelect ? "group" : "radiogroup"}
        aria-labelledby={questionId}
        className="flex flex-col gap-0.5"
      >
        {question.options.map((option, index) => (
          <OptionRow
            key={`${page}-${index}`}
            index={index}
            label={option.label}
            description={option.description}
            multiSelect={question.multiSelect}
            selected={current.selected.includes(index)}
            highlighted={hasFocus && highlight === index}
            onPick={() => {
              pick(index, sendsOnPick);
              if (!sendsOnPick) setFocusTarget("panel");
            }}
          />
        ))}
        {optionCount > 0 ? (
          <div
            className={cn(
              "flex items-center gap-2 rounded px-1.5 py-1",
              otherSelected
                ? "bg-list-active text-list-active-foreground"
                : "hover:bg-list-hover",
              hasFocus &&
                highlight === optionCount &&
                "outline-command-border-focus outline outline-1 -outline-offset-1",
            )}
            onClick={() => {
              if (!current.otherOn) setOther(current.other);
              setFocusTarget("other");
            }}
          >
            <ChoiceBadge
              multiSelect={question.multiSelect}
              selected={otherSelected}
            >
              <PencilIcon className="h-2.5 w-2.5" />
            </ChoiceBadge>
            <input
              ref={otherRef}
              type="text"
              autoComplete="off"
              aria-label="Other answer"
              placeholder="Other: type your own answer"
              data-testid="ask-question-other"
              value={current.other}
              onChange={(e) => setOther(e.target.value)}
              className="text-input-foreground placeholder:text-input-placeholder focus:border-border-focus focus:bg-editor w-full min-w-0 rounded border border-solid border-transparent bg-transparent px-1 py-0.5 outline-none"
              style={{ font: "inherit" }}
            />
          </div>
        ) : (
          <textarea
            ref={otherRef}
            rows={2}
            aria-label="Your answer"
            placeholder="Type your answer"
            data-testid="ask-question-other"
            value={current.other}
            onChange={(e) => setOther(e.target.value)}
            className="text-input-foreground placeholder:text-input-placeholder border-input-border focus:border-border-focus bg-editor min-h-12 w-full resize-y rounded border border-solid px-2 py-1.5 outline-none"
            style={{ font: "inherit" }}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <span
          role="status"
          className={cn(
            "min-w-0 flex-1",
            warning ? "text-warning" : "text-description-muted",
          )}
          style={{ fontSize: captionFont }}
        >
          {warning || <span className="hidden sm:inline">{keyHint}</span>}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="text-description my-0"
          onClick={skip}
          data-testid="ask-question-skip"
        >
          Skip
          <Kbd>Esc</Kbd>
        </Button>
        <Button
          variant="primary"
          size="sm"
          className={cn("my-0", !answered && "opacity-50")}
          aria-disabled={!answered}
          onClick={goNext}
          data-testid="ask-question-next"
        >
          {isLast ? "Send" : "Next"}
          <Kbd>⏎</Kbd>
        </Button>
      </div>
    </div>
  );
}
