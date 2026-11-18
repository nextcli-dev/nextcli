import {
  type AnswerSet,
  draftsToAnswerSet,
  emptyDraft,
  firstUnanswered,
  isDraftAnswered,
  pickOption,
  type QuestionDraft,
  type QuestionSet,
  skipDraft,
  typeOther,
} from "@nextcli/ask-question";
import { Box, type Key, Text, useInput } from "ink";
import React, { useState } from "react";

import { defaultBoxStyles } from "../styles.js";

interface QuizPromptProps {
  set: QuestionSet;
  requestId: string;
  onAnswer: (requestId: string, answers: AnswerSet) => void;
}

/** Highest option a number key can pick. */
const MAX_NUMBER_KEY = 9;

function replaceAt<T>(list: T[], index: number, value: T): T[] {
  return list.map((item, i) => (i === index ? value : item));
}

interface PromptState {
  drafts: QuestionDraft[];
  page: number;
  /** Highlighted row per question; the row after the options is "Other". */
  highlight: number[];
  /** Keys go to the "Other" text. */
  typing: boolean;
  warning: string;
}

/**
 * The AskQuestion prompt. It replaces the input line while a question set is
 * open. Esc skips a question; Ctrl+C dismisses them all and ends the turn.
 */
export const QuizPrompt: React.FC<QuizPromptProps> = ({
  set,
  requestId,
  onAnswer,
}) => {
  const total = set.questions.length;
  const [state, setState] = useState<PromptState>(() => ({
    drafts: set.questions.map(() => emptyDraft()),
    page: 0,
    highlight: set.questions.map(() => 0),
    typing: set.questions[0]?.options.length === 0,
    warning: "",
  }));
  const [submitted, setSubmitted] = useState(false);

  const question = set.questions[state.page];
  const draft = state.drafts[state.page];
  const optionCount = question.options.length;
  const highlight = state.highlight[state.page] ?? 0;
  const typing = optionCount === 0 || state.typing;
  const isLast = state.page === total - 1;

  function finish(answers: AnswerSet) {
    setSubmitted(true);
    onAnswer(requestId, answers);
  }

  function withDraft(next: QuestionDraft, nextHighlight = highlight) {
    return {
      ...state,
      drafts: replaceAt(state.drafts, state.page, next),
      highlight: replaceAt(state.highlight, state.page, nextHighlight),
    };
  }

  function onPage(next: PromptState, page: number, warning = "") {
    setState({
      ...next,
      page,
      typing: set.questions[page].options.length === 0,
      warning,
    });
  }

  /** Moves on from the current question, or sends when it is the last one. */
  function advance(next: PromptState) {
    if (next.page < total - 1) {
      onPage(next, next.page + 1);
      return;
    }
    const missing = firstUnanswered(set, next.drafts);
    if (missing >= 0) {
      onPage(next, missing, `Answer or skip question ${missing + 1} first.`);
      return;
    }
    finish(draftsToAnswerSet(set, next.drafts));
  }

  function goNext() {
    if (!isDraftAnswered(question, draft)) {
      setState({
        ...state,
        warning:
          optionCount === 0
            ? "Type an answer, or press Esc to skip."
            : question.multiSelect
              ? "Pick at least one option, or press Esc to skip."
              : "Pick an option, or press Esc to skip.",
      });
      return;
    }
    advance(state);
  }

  function pick(index: number, thenAdvance: boolean) {
    const next = {
      ...withDraft(pickOption(question, draft, index), index),
      typing: false,
      warning: "",
    };
    if (thenAdvance) advance(next);
    else setState(next);
  }

  function setOther(text: string) {
    setState({
      ...withDraft(typeOther(question, draft, text), optionCount),
      typing: true,
      warning: "",
    });
  }

  function goPage(delta: number) {
    const page = state.page + delta;
    if (page >= 0 && page < total) onPage(state, page);
  }

  function moveHighlight(delta: number) {
    const next = Math.max(0, Math.min(optionCount, highlight + delta));
    setState({
      ...withDraft(draft, next),
      typing: next === optionCount,
      warning: "",
    });
  }

  function onEscape() {
    if (state.typing && optionCount > 0) {
      setState({ ...withDraft(draft, optionCount), typing: false });
    } else {
      advance(withDraft(skipDraft()));
    }
  }

  function onEnter() {
    if (typing || question.multiSelect) {
      goNext();
    } else if (highlight < optionCount) {
      pick(highlight, true);
    } else {
      setState({ ...state, typing: true });
    }
  }

  /** Keys while the "Other" text (or a free-text answer) has the cursor. */
  function onTypingKey(input: string, key: Key) {
    if (key.backspace || key.delete) {
      setOther(draft.other.slice(0, -1));
    } else if (key.upArrow && optionCount > 0) {
      setState({ ...withDraft(draft, optionCount - 1), typing: false });
    } else if (input && !key.upArrow && !key.downArrow && !key.tab) {
      setOther(draft.other + input);
    }
  }

  /** Keys while an option row is highlighted. */
  function onOptionKey(input: string, key: Key) {
    if (key.upArrow || key.downArrow) {
      moveHighlight(key.downArrow ? 1 : -1);
      return;
    }
    if (input === " ") {
      if (highlight < optionCount) pick(highlight, false);
      else setState({ ...state, typing: true });
      return;
    }
    const number = /^[1-9]$/.test(input) ? Number(input) : 0;
    if (number) {
      if (number <= Math.min(optionCount, MAX_NUMBER_KEY)) {
        pick(number - 1, false);
      }
      return;
    }
    // Typing anywhere starts an "Other" answer
    if (input && !key.tab) setOther(draft.other + input);
  }

  useInput((input, key) => {
    if (submitted) return;
    if (key.ctrl && input === "c") {
      finish({ dismissed: true });
    } else if (key.escape) {
      onEscape();
    } else if (key.return) {
      onEnter();
    } else if (key.leftArrow || key.rightArrow) {
      goPage(key.rightArrow ? 1 : -1);
    } else if (!key.ctrl && !key.meta) {
      if (typing) onTypingKey(input, key);
      else onOptionKey(input, key);
    }
  });

  if (submitted) {
    return null;
  }

  const multi = question.multiSelect;
  const indent = multi ? 9 : 5;
  const meta = [
    total > 1 ? `Question ${state.page + 1} of ${total}` : "",
    question.header ?? "",
    multi ? "select all that apply" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const keys = [
    optionCount ? "↑/↓ move" : "",
    optionCount ? `1–${Math.min(optionCount, MAX_NUMBER_KEY)} pick` : "",
    multi ? "Space toggle" : "",
    `Enter ${isLast ? "send" : "next"}`,
    "Esc skip",
    total > 1 ? "←/→ page" : "",
    "Ctrl+C dismiss",
  ]
    .filter(Boolean)
    .join(" · ");
  const otherSelected = draft.otherOn && draft.other.trim() !== "";

  return (
    <Box {...defaultBoxStyles("magenta")} marginBottom={1}>
      <Box>
        <Text color="magenta" bold>
          ?{" "}
        </Text>
        <Text bold>{question.question}</Text>
      </Box>
      {meta && (
        <Box marginLeft={2}>
          <Text color="gray">{meta}</Text>
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {optionCount === 0 ? (
          <Box>
            <Text color="cyan">❯ </Text>
            <Text>{draft.other}</Text>
            <Text color="gray">▊</Text>
          </Box>
        ) : (
          <>
            {question.options.map((option, index) => {
              const isHighlighted = !typing && highlight === index;
              const isSelected = draft.selected.includes(index);
              const mark = multi ? (isSelected ? "[x] " : "[ ] ") : "";
              return (
                <Box key={index} flexDirection="column">
                  <Box>
                    <Box width={indent} flexShrink={0}>
                      <Text
                        color={isHighlighted ? "cyan" : undefined}
                        bold={isHighlighted}
                      >
                        {`${isHighlighted ? "❯ " : "  "}${mark}${index + 1}.`}
                      </Text>
                    </Box>
                    <Text
                      color={isHighlighted ? "cyan" : undefined}
                      bold={isHighlighted}
                    >
                      {option.label}
                      {!multi && isSelected ? (
                        <Text color="green"> ✓</Text>
                      ) : null}
                    </Text>
                  </Box>
                  {option.description && (
                    <Box marginLeft={indent}>
                      <Text color="gray">{option.description}</Text>
                    </Box>
                  )}
                </Box>
              );
            })}
            <Box>
              <Box width={indent} flexShrink={0}>
                <Text color={typing ? "cyan" : undefined} bold={typing}>
                  {`${typing ? "❯ " : "  "}${multi ? (otherSelected ? "[x] " : "[ ] ") : ""}✎`}
                </Text>
              </Box>
              {draft.other ? (
                <Text color={typing ? "cyan" : undefined}>{draft.other}</Text>
              ) : (
                <Text color="gray">Other: start typing</Text>
              )}
              {typing && <Text color="gray">▊</Text>}
            </Box>
          </>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {state.warning && <Text color="yellow">{state.warning}</Text>}
        <Text color="gray" dimColor>
          {keys}
        </Text>
      </Box>
    </Box>
  );
};
