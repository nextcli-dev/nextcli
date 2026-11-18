import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  QuestionMarkCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  AnswerSet,
  FormEvent,
  FormState,
  isDraftAnswered,
  MAX_NUMBER_KEY,
  normalizeQuestionArgs,
  QuestionSet,
  reduceForm,
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
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import {
  dismissQuestion,
  submitQuestionAnswers,
} from "../../../redux/thunks/answerQuestion";
import { getMetaKeyLabel, isMetaEquivalentKeyPressed } from "../../../util";
import {
  loadQuestionDraft,
  saveQuestionDraft,
} from "../../../util/askQuestionDrafts";
import { cn } from "../../../util/cn";
import { Button } from "../../ui/Button";
import { FONT_STEP, useFontSize } from "../../ui/font";
import { QUESTION_PANEL_ATTRIBUTE } from "../focusChatInput";
import { useMainEditor } from "../TipTapEditor/MainEditorProvider";
import { ChoiceBadge, OptionRow } from "./OptionRow";

const PANEL_CLASS =
  "bg-input text-input-foreground border-command-border focus-within:border-command-border-focus rounded-default flex flex-col gap-1.5 border border-solid px-2 pb-1.5 pt-2 outline-none max-h-[60vh]";

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
 * The paging, picking and sending rules are @nextcli/ask-question's form,
 * shared with the cn prompt; this maps keys and clicks to its events.
 */
export function AskQuestionPanel({
  toolCallState,
}: {
  toolCallState: ToolCallState;
}) {
  // core ran the same normalization before the call reached "calling"
  const set = useMemo(
    () => normalizeQuestionArgs(toolCallState.parsedArgs),
    [toolCallState.parsedArgs],
  );
  return <QuestionForm toolCallId={toolCallState.toolCallId} set={set} />;
}

function QuestionForm({
  toolCallId,
  set,
}: {
  toolCallId: string;
  set: QuestionSet;
}) {
  const dispatch = useAppDispatch();
  const sessionId = useAppSelector((state) => state.session.id);
  const { mainEditor } = useMainEditor();
  // Question and options at the size of the chat's tool call rows
  const rowFont = useFontSize(FONT_STEP.row);
  const controlFont = useFontSize(FONT_STEP.control);
  const captionFont = useFontSize(FONT_STEP.caption);
  const [form, setForm] = useState<FormState>(() =>
    loadQuestionDraft(toolCallId, set),
  );
  // Bumped after each event that should move focus to the field or the panel
  const [focusRequest, setFocusRequest] = useState(1);
  const [hasFocus, setHasFocus] = useState(false);
  const finished = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const otherRowRef = useRef<HTMLDivElement>(null);

  const total = set.questions.length;
  const page = form.page;
  const question = set.questions[page];
  const current = form.drafts[page];
  const optionCount = question.options.length;
  const highlight = form.highlight[page] ?? 0;
  const isLast = page === total - 1;
  const answered = isDraftAnswered(question, current);
  const otherHighlighted = hasFocus && highlight === optionCount;

  // Focus moves without scrolling, so keep the highlighted row in view
  useEffect(() => {
    if (otherHighlighted) {
      otherRowRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [otherHighlighted]);

  useEffect(() => {
    if (!finished.current) saveQuestionDraft(toolCallId, sessionId, form);
  }, [toolCallId, sessionId, form]);

  // The editor grabs focus when streaming stops, which is exactly when the
  // panel appears, so focus is moved after the next paint.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const field = otherRef.current;
      if (form.editing && field) {
        if (document.activeElement !== field) {
          field.focus({ preventScroll: true });
          field.setSelectionRange(field.value.length, field.value.length);
        }
      } else {
        panelRef.current?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, form.editing, page]);

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

  /** Runs a form event; `moveFocus` is false while the field keeps focus. */
  function apply(event: FormEvent, moveFocus = true) {
    if (finished.current) return;
    const step = reduceForm(set, form, event);
    setForm(step.state);
    if (step.answers) {
      finish(step.answers);
    } else if (moveFocus) {
      setFocusRequest((n) => n + 1);
    }
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
        apply({ type: "next" });
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
      apply({ type: "escape" });
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !anyMod) {
      e.preventDefault();
      apply({ type: "enter" });
      return;
    }
    if (inText) {
      // Other keys edit the text; ←/→ move the caret. ↑ at the start of the
      // "Other" field goes back to the options.
      const field = target as HTMLInputElement;
      if (
        e.key === "ArrowUp" &&
        optionCount > 0 &&
        field.selectionStart === 0 &&
        field.selectionEnd === 0
      ) {
        e.preventDefault();
        apply({ type: "move", delta: -1 });
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      apply({ type: "move", delta: e.key === "ArrowDown" ? 1 : -1 });
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      apply({ type: "page", delta: e.key === "ArrowRight" ? 1 : -1 });
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      apply({ type: "toggle" });
      return;
    }
    if (anyMod || e.altKey || e.key.length !== 1) return;
    const number = Number(e.key);
    if (Number.isInteger(number) && number >= 1 && number <= MAX_NUMBER_KEY) {
      if (number <= optionCount) {
        e.preventDefault();
        apply({ type: "pick", index: number - 1 });
      }
      return;
    }
    if (optionCount > 0) {
      // Typing anywhere in the panel writes the "Other" answer.
      e.preventDefault();
      apply({ type: "type", text: current.other + e.key });
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
      {...{ [QUESTION_PANEL_ATTRIBUTE]: "" }}
      className={PANEL_CLASS}
      style={{ fontSize: rowFont }}
      onKeyDown={onKeyDown}
      onFocus={() => setHasFocus(true)}
      onBlur={onBlur}
    >
      <div
        className="text-description flex min-h-5 shrink-0 items-center gap-1.5"
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
              onClick={() => apply({ type: "page", delta: -1 })}
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
              onClick={() => apply({ type: "page", delta: 1 })}
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

      {/* The question and its options scroll; the header and the Skip and
          Send row stay in view, so a long question can't push them out */}
      <div
        className="thin-scrollbar flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto"
        data-testid="ask-question-body"
      >
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
              onPick={() => apply({ type: "pick", index })}
            />
          ))}
          {optionCount > 0 ? (
            <div
              ref={otherRowRef}
              className={cn(
                "flex items-center gap-2 rounded px-1.5 py-1",
                otherSelected
                  ? "bg-list-active text-list-active-foreground"
                  : "hover:bg-list-hover",
                otherHighlighted &&
                  "outline-command-border-focus outline outline-1 -outline-offset-1",
              )}
              onClick={() => apply({ type: "editOther" })}
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
                onFocus={() =>
                  !form.editing && apply({ type: "editOther" }, false)
                }
                onChange={(e) =>
                  apply({ type: "type", text: e.target.value }, false)
                }
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
              onChange={(e) =>
                apply({ type: "type", text: e.target.value }, false)
              }
              className="text-input-foreground placeholder:text-input-placeholder border-input-border focus:border-border-focus bg-editor min-h-12 w-full resize-y rounded border border-solid px-2 py-1.5 outline-none"
              style={{ font: "inherit" }}
            />
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <span
          role="status"
          className={cn(
            "min-w-0 flex-1",
            form.warning ? "text-warning" : "text-description-muted",
          )}
          style={{ fontSize: captionFont }}
        >
          {form.warning || <span className="hidden sm:inline">{keyHint}</span>}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="text-description my-0"
          onClick={() => apply({ type: "skip" })}
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
          onClick={() => apply({ type: "next" })}
          data-testid="ask-question-next"
        >
          {isLast ? "Send" : "Next"}
          <Kbd>⏎</Kbd>
        </Button>
      </div>
    </div>
  );
}
