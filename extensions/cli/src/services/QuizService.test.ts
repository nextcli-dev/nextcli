import { describe, expect, it } from "vitest";

import { askQuestionTool } from "../tools/askQuestion.js";

import { QuestionRequestedEvent, QuizService } from "./QuizService.js";

describe("QuizService", () => {
  it("returns the answer the terminal UI gives", async () => {
    const quiz = new QuizService();
    quiz.on("questionRequested", (event: QuestionRequestedEvent) => {
      quiz.answerQuestion(event.requestId, "Option B");
    });

    await expect(
      quiz.askQuestion({ question: "Which?", options: ["A", "Option B"] }),
    ).resolves.toBe("Option B");
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

    await expect(quiz.askQuestion({ question: "Which?" })).rejects.toThrow(
      /Nobody can answer questions/,
    );
  });

  it("makes the AskQuestion tool fail when no terminal UI is listening", async () => {
    await expect(
      askQuestionTool.run({ question: "Which?", options: ["A", "B"] }),
    ).rejects.toThrow(/Continue without asking/);
  });
});
