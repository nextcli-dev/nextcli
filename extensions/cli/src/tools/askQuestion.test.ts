import { DISMISS_TEXT } from "@nextcli/ask-question";
import { afterEach, describe, expect, it } from "vitest";

import {
  QuestionRequestedEvent,
  quizService,
} from "../services/QuizService.js";

import { askQuestionTool } from "./askQuestion.js";

const answerWith =
  (answers: Parameters<typeof quizService.answerQuestions>[1]) =>
  (event: QuestionRequestedEvent) => {
    quizService.answerQuestions(event.requestId, answers);
  };

describe("AskQuestion", () => {
  afterEach(() => {
    quizService.removeAllListeners("questionRequested");
  });

  it("repairs cosmetic problems in preprocess", async () => {
    const { args } = await askQuestionTool.preprocess!({
      questions: [
        { header: "Which database?", options: ["Postgres", "Other"] },
      ],
    });
    expect(args).toEqual({
      questions: [
        {
          question: "Which database?",
          options: [{ label: "Postgres" }],
          multiSelect: false,
        },
      ],
    });
  });

  it("rejects arguments it cannot show, with a message for the model", async () => {
    await expect(
      askQuestionTool.preprocess!({ questions: [{ options: ["a", "b"] }] }),
    ).rejects.toThrow(
      'Question 1 has no "question" text. Fix the arguments and call the tool again.',
    );
  });

  it("returns the answers as the shared text", async () => {
    const { args } = await askQuestionTool.preprocess!({
      questions: [
        { question: "Which database?", options: ["Postgres", "SQLite"] },
        {
          question: "Which endpoints?",
          options: ["Read", "Write"],
          multiSelect: true,
        },
      ],
    });
    quizService.on(
      "questionRequested",
      answerWith({
        dismissed: false,
        answers: [
          { status: "skipped" },
          { status: "answered", selected: ["Read", "Write"], other: "Admin" },
        ],
      }),
    );

    await expect(askQuestionTool.run(args)).resolves.toBe(
      [
        "The user answered your questions:",
        "1. Which database?",
        "   → Skipped. Use your judgment and state the assumption you make.",
        "2. Which endpoints? (multiple choice)",
        "   → Read; Write",
        '   → Other: "Admin"',
      ].join("\n"),
    );
  });

  it("returns the dismissal text when the user dismisses", async () => {
    const { args } = await askQuestionTool.preprocess!({
      questions: [{ question: "Ok?", options: ["Yes", "No"] }],
    });
    quizService.on("questionRequested", answerWith({ dismissed: true }));

    await expect(askQuestionTool.run(args)).resolves.toBe(DISMISS_TEXT);
  });
});
