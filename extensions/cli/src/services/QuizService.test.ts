import { normalizeQuestionArgs } from "@nextcli/ask-question";
import { describe, expect, it } from "vitest";

import { askQuestionTool } from "../tools/askQuestion.js";
import { ToolInterruptedError } from "../tools/toolInterruptedError.js";

import {
  QuestionAnsweredEvent,
  QuestionRequestedEvent,
  QuizService,
} from "./QuizService.js";

const set = normalizeQuestionArgs({
  questions: [{ question: "Which?", options: ["A", "B"] }],
});

describe("QuizService", () => {
  it("returns the answers the terminal UI gives", async () => {
    const quiz = new QuizService();
    quiz.on("questionRequested", (event: QuestionRequestedEvent) => {
      expect(event.set).toBe(set);
      quiz.answerQuestions(event.requestId, {
        dismissed: false,
        answers: [{ status: "answered", selected: ["B"] }],
      });
    });

    await expect(quiz.askQuestions(set)).resolves.toEqual({
      dismissed: false,
      answers: [{ status: "answered", selected: ["B"] }],
    });
  });

  it("shows parallel question sets one at a time, each with its own id", async () => {
    const quiz = new QuizService();
    const shown: QuestionRequestedEvent[] = [];
    quiz.on("questionRequested", (event: QuestionRequestedEvent) => {
      shown.push(event);
    });

    const first = quiz.askQuestions(set);
    const second = quiz.askQuestions(set);
    await new Promise((resolve) => setImmediate(resolve));
    expect(shown).toHaveLength(1);

    quiz.answerQuestions(shown[0].requestId, { dismissed: true });
    await expect(first).resolves.toEqual({ dismissed: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(shown).toHaveLength(2);
    expect(shown[1].requestId).not.toBe(shown[0].requestId);

    quiz.answerQuestions(shown[1].requestId, {
      dismissed: false,
      answers: [{ status: "skipped" }],
    });
    await expect(second).resolves.toMatchObject({ dismissed: false });
  });

  it("ignores an answer for a request that is not pending", () => {
    const quiz = new QuizService();
    expect(quiz.answerQuestions("quiz-404", { dismissed: true })).toBe(false);
  });

  it("closes the prompt and fails the call when the turn is interrupted", async () => {
    const quiz = new QuizService();
    const answered: QuestionAnsweredEvent[] = [];
    let requestId = "";
    quiz.on("questionRequested", (event: QuestionRequestedEvent) => {
      requestId = event.requestId;
    });
    quiz.on("questionAnswered", (event: QuestionAnsweredEvent) => {
      answered.push(event);
    });

    const controller = new AbortController();
    const asked = quiz.askQuestions(set, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(asked).rejects.toBeInstanceOf(ToolInterruptedError);
    expect(answered).toEqual([{ requestId }]);
    // A late answer goes nowhere, and the next question still shows
    expect(quiz.answerQuestions(requestId, { dismissed: true })).toBe(false);
  });

  it("can ask questions only while something listens for them", () => {
    const quiz = new QuizService();
    expect(quiz.canAskQuestions()).toBe(false);

    const listener = () => {};
    quiz.on("questionRequested", listener);
    expect(quiz.canAskQuestions()).toBe(true);

    quiz.off("questionRequested", listener);
    expect(quiz.canAskQuestions()).toBe(false);
  });

  it("fails at once when nothing can answer, instead of waiting forever", async () => {
    const quiz = new QuizService();

    await expect(quiz.askQuestions(set)).rejects.toThrow(
      /Nobody can answer questions/,
    );
  });

  it("makes the AskQuestion tool fail when no terminal UI is listening", async () => {
    await expect(askQuestionTool.run(set)).rejects.toThrow(
      /Continue without asking/,
    );
  });
});
