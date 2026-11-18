import { normalizeQuestionArgs, type AnswerSet } from "@nextcli/ask-question";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { QuizPrompt } from "./QuizPrompt.js";

// Generous timeout: ink renders slowly when the whole suite runs in parallel
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 5000 });

const UP = "\u001B[A";
const DOWN = "\u001B[B";
const RIGHT = "\u001B[C";
const LEFT = "\u001B[D";
const ENTER = "\r";
const ESC = "\u001B";
const CTRL_C = "\u0003";

// Let React re-register the prompt's key handler before each key (see
// ModelMenu.test.tsx): a key sent in between reaches the stale handler.
const press = async (stdin: { write: (data: string) => void }, key: string) => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  stdin.write(key);
};

const twoQuestions = normalizeQuestionArgs({
  questions: [
    {
      question: "How should failed requests be retried?",
      header: "Strategy",
      options: [
        { label: "Exponential backoff", description: "Doubles the wait" },
        "Fixed delay",
      ],
    },
    {
      question: "Which failures should trigger a retry?",
      options: ["HTTP 429", "HTTP 503", "Timeouts"],
      multiSelect: true,
    },
  ],
});

function renderPrompt(set = twoQuestions) {
  const onAnswer = vi.fn<(requestId: string, answers: AnswerSet) => void>();
  const rendered = render(
    <QuizPrompt set={set} requestId="quiz-1" onAnswer={onAnswer} />,
  );
  return { ...rendered, onAnswer };
}

describe("QuizPrompt", () => {
  it("shows the question, its options and the keys", () => {
    const { lastFrame } = renderPrompt();
    const frame = lastFrame()!;
    expect(frame).toContain("How should failed requests be retried?");
    expect(frame).toContain("Question 1 of 2 · Strategy");
    expect(frame).toContain("1. Exponential backoff");
    expect(frame).toContain("Doubles the wait");
    expect(frame).toContain("Other: start typing");
    expect(frame).toContain("Esc skip");
    expect(frame).toContain("Ctrl+C dismiss");
  });

  it("answers with arrows, Enter, number keys, Space and typing", async () => {
    const { stdin, lastFrame, onAnswer } = renderPrompt();

    await press(stdin, DOWN);
    await press(stdin, ENTER);
    await waitFor(() => expect(lastFrame()).toContain("Question 2 of 2"));

    await press(stdin, "1");
    await press(stdin, DOWN);
    await press(stdin, DOWN);
    await press(stdin, " ");
    await waitFor(() => expect(lastFrame()).toContain("[x] 3. Timeouts"));
    await press(stdin, "r");
    await press(stdin, "s");
    await press(stdin, "t");
    await waitFor(() => expect(lastFrame()).toContain("rst"));
    await press(stdin, ENTER);

    await waitFor(() => expect(onAnswer).toHaveBeenCalled());
    expect(onAnswer).toHaveBeenCalledWith("quiz-1", {
      dismissed: false,
      answers: [
        { status: "answered", selected: ["Fixed delay"] },
        {
          status: "answered",
          selected: ["HTTP 429", "Timeouts"],
          other: "rst",
        },
      ],
    });
  });

  it("asks for an answer before moving on", async () => {
    const { stdin, lastFrame, onAnswer } = renderPrompt();

    await press(stdin, RIGHT);
    await waitFor(() => expect(lastFrame()).toContain("Question 2 of 2"));
    await press(stdin, ENTER);
    await waitFor(() =>
      expect(lastFrame()).toContain(
        "Pick at least one option, or press Esc to skip.",
      ),
    );
    await press(stdin, "2");
    await press(stdin, ENTER);
    await waitFor(() =>
      expect(lastFrame()).toContain("Answer or skip question 1 first."),
    );
    expect(lastFrame()).toContain("Question 1 of 2");
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("skips with Esc, leaving the Other field first", async () => {
    const { stdin, lastFrame, onAnswer } = renderPrompt();

    await press(stdin, "x");
    await waitFor(() => expect(lastFrame()).toContain("x▊"));
    await press(stdin, ESC);
    await waitFor(() => expect(lastFrame()).not.toContain("x▊"));
    await press(stdin, ESC);
    await waitFor(() => expect(lastFrame()).toContain("Question 2 of 2"));
    await press(stdin, ESC);

    await waitFor(() => expect(onAnswer).toHaveBeenCalled());
    expect(onAnswer).toHaveBeenCalledWith("quiz-1", {
      dismissed: false,
      answers: [{ status: "skipped" }, { status: "skipped" }],
    });
  });

  it("dismisses everything with Ctrl+C", async () => {
    const { stdin, onAnswer } = renderPrompt();

    await press(stdin, CTRL_C);

    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("quiz-1", { dismissed: true }),
    );
  });

  it("takes a typed answer for a free-text question", async () => {
    const { stdin, lastFrame, onAnswer } = renderPrompt(
      normalizeQuestionArgs({
        questions: [{ question: "Table name?", options: [] }],
      }),
    );

    for (const key of "chat_sessions") await press(stdin, key);
    await waitFor(() => expect(lastFrame()).toContain("chat_sessions"));
    await press(stdin, ENTER);

    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("quiz-1", {
        dismissed: false,
        answers: [{ status: "answered", selected: [], other: "chat_sessions" }],
      }),
    );
  });

  it("moves the caret with the arrows while typing, not the page", async () => {
    const { stdin, lastFrame } = renderPrompt();

    await press(stdin, "a");
    await press(stdin, "c");
    await waitFor(() => expect(lastFrame()).toContain("ac▊"));
    await press(stdin, LEFT);
    await waitFor(() => expect(lastFrame()).toContain("a▊c"));
    await press(stdin, "b");
    await waitFor(() => expect(lastFrame()).toContain("ab▊c"));
    expect(lastFrame()).toContain("Question 1 of 2");
  });

  it("answers and sends a lone question with a number key", async () => {
    const { stdin, onAnswer } = renderPrompt(
      normalizeQuestionArgs({
        questions: [
          { question: "Which database?", options: ["Postgres", "SQLite"] },
        ],
      }),
    );

    await press(stdin, "2");

    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith("quiz-1", {
        dismissed: false,
        answers: [{ status: "answered", selected: ["SQLite"] }],
      }),
    );
  });

  it("moves from the Other field back to the options with the up arrow", async () => {
    const { stdin, lastFrame } = renderPrompt();

    await press(stdin, DOWN);
    await press(stdin, DOWN);
    await waitFor(() => expect(lastFrame()).toContain("❯ ✎"));
    await press(stdin, UP);
    await waitFor(() => expect(lastFrame()).toContain("❯ 2. Fixed delay"));
  });
});
