import {
  type AnswerSet,
  type FormEvent,
  type FormState,
  initialFormState,
  MAX_NUMBER_KEY,
  type QuestionSet,
  reduceForm,
} from "@nextcli/ask-question";
import { Box, type Key, Text, useInput } from "ink";
import React, { useState } from "react";

import { defaultBoxStyles } from "../styles.js";

interface QuizPromptProps {
  set: QuestionSet;
  requestId: string;
  onAnswer: (requestId: string, answers: AnswerSet) => void;
}

/** The answer being typed, with a caret at `cursor`. */
const TypedText: React.FC<{ text: string; cursor: number; color?: string }> = ({
  text,
  cursor,
  color,
}) => (
  <Text color={color}>
    {text.slice(0, cursor)}
    <Text color="gray">▊</Text>
    {text.slice(cursor)}
  </Text>
);

/**
 * The AskQuestion prompt. It replaces the input line while a question set is
 * open. Esc skips a question; Ctrl+C dismisses them all and ends the turn.
 * The paging, picking and sending rules are @nextcli/ask-question's form,
 * shared with the VS Code panel; this maps keys to its events.
 */
export const QuizPrompt: React.FC<QuizPromptProps> = ({
  set,
  requestId,
  onAnswer,
}) => {
  const total = set.questions.length;
  const [form, setForm] = useState<FormState>(() => initialFormState(set));
  /** Caret position in the "Other" or free-text answer. */
  const [cursor, setCursor] = useState(0);
  const [submitted, setSubmitted] = useState(false);

  const question = set.questions[form.page];
  const draft = form.drafts[form.page];
  const optionCount = question.options.length;
  const highlight = form.highlight[form.page] ?? 0;
  const typing = optionCount === 0 || form.editing;
  const isLast = form.page === total - 1;

  function finish(answers: AnswerSet) {
    setSubmitted(true);
    onAnswer(requestId, answers);
  }

  function apply(event: FormEvent, nextCursor?: number) {
    const step = reduceForm(set, form, event);
    if (step.answers) {
      finish(step.answers);
      return;
    }
    setForm(step.state);
    const text = step.state.drafts[step.state.page].other;
    if (nextCursor !== undefined) {
      setCursor(nextCursor);
    } else if (
      step.state.page !== form.page ||
      (step.state.editing && !form.editing)
    ) {
      // A new page or a fresh start in the field puts the caret at the end
      setCursor(text.length);
    }
  }

  /** Keys while the "Other" text (or a free-text answer) has the caret. */
  function onTypingKey(input: string, key: Key) {
    const text = draft.other;
    const at = Math.min(cursor, text.length);
    if (key.leftArrow) {
      setCursor(Math.max(0, at - 1));
    } else if (key.rightArrow) {
      setCursor(Math.min(text.length, at + 1));
    } else if (key.upArrow) {
      apply({ type: "move", delta: -1 });
    } else if (key.backspace || key.delete) {
      if (at > 0) {
        apply(
          { type: "type", text: text.slice(0, at - 1) + text.slice(at) },
          at - 1,
        );
      }
    } else if (input && !key.downArrow && !key.tab) {
      const typed = input.replace(/[\r\n]+/g, " ");
      apply(
        { type: "type", text: text.slice(0, at) + typed + text.slice(at) },
        at + typed.length,
      );
    }
  }

  /** Keys while an option row is highlighted. */
  function onOptionKey(input: string, key: Key) {
    if (key.upArrow || key.downArrow) {
      apply({ type: "move", delta: key.downArrow ? 1 : -1 });
    } else if (key.leftArrow || key.rightArrow) {
      apply({ type: "page", delta: key.rightArrow ? 1 : -1 });
    } else if (input === " ") {
      apply({ type: "toggle" });
    } else if (/^[1-9]$/.test(input)) {
      const number = Number(input);
      if (number <= Math.min(optionCount, MAX_NUMBER_KEY)) {
        apply({ type: "pick", index: number - 1 });
      }
    } else if (input && !key.tab) {
      // Typing anywhere starts an "Other" answer
      apply(
        { type: "type", text: draft.other + input },
        draft.other.length + input.length,
      );
    }
  }

  useInput((input, key) => {
    if (submitted) return;
    if (key.ctrl && input === "c") {
      finish({ dismissed: true });
    } else if (key.escape) {
      apply({ type: "escape" });
    } else if (key.return) {
      apply({ type: "enter" });
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
    total > 1 ? `Question ${form.page + 1} of ${total}` : "",
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
    total > 1 && !typing ? "←/→ page" : "",
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
            <TypedText text={draft.other} cursor={cursor} />
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
              {typing ? (
                <TypedText text={draft.other} cursor={cursor} color="cyan" />
              ) : draft.other ? (
                <Text>{draft.other}</Text>
              ) : (
                <Text color="gray">Other: start typing</Text>
              )}
            </Box>
          </>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {form.warning && <Text color="yellow">{form.warning}</Text>}
        <Text color="gray" dimColor>
          {keys}
        </Text>
      </Box>
    </Box>
  );
};
