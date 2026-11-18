import { describe, expect, it } from "vitest";

import {
  ALL_SKIPPED_TEXT,
  DISMISS_TEXT,
  formatAnswers,
  normalizeQuestionArgs,
} from "../src/index.js";

const set = normalizeQuestionArgs({
  questions: [
    {
      question: "Which part should I review?",
      options: ["The state machine (Recommended)", "The stop path"],
    },
    {
      question: "Which concerns matter most?",
      options: ["Shortcuts", "Precedence", "Focus"],
      multiSelect: true,
    },
    { question: "What should the table be called?", options: [] },
    { question: "Should I also check the CLI?", options: ["Yes", "No"] },
  ],
});

describe("formatAnswers", () => {
  it("lists each answer, keeping typed answers apart from picked options", () => {
    expect(
      formatAnswers(set, {
        dismissed: false,
        answers: [
          { status: "answered", selected: ["The state machine (Recommended)"] },
          {
            status: "answered",
            selected: ["Shortcuts", "Precedence"],
            other: "the Stop button flickers",
          },
          { status: "answered", selected: [], other: "chat_sessions" },
          { status: "skipped" },
        ],
      }),
    ).toBe(
      [
        "The user answered your questions:",
        "1. Which part should I review?",
        "   → The state machine (Recommended)",
        "2. Which concerns matter most? (multiple choice)",
        "   → Shortcuts; Precedence",
        '   → Other: "the Stop button flickers"',
        "3. What should the table be called?",
        '   → "chat_sessions"',
        "4. Should I also check the CLI?",
        "   → Skipped. Use your judgment and state the assumption you make.",
      ].join("\n"),
    );
  });

  it("uses the singular heading for one question", () => {
    const one = normalizeQuestionArgs({
      questions: [{ question: "Ok?", options: ["Yes", "No"] }],
    });
    expect(
      formatAnswers(one, {
        dismissed: false,
        answers: [{ status: "answered", selected: [], other: "Maybe" }],
      }),
    ).toBe('The user answered your question:\n1. Ok?\n   → Other: "Maybe"');
  });

  it("returns the dismissal text", () => {
    expect(formatAnswers(set, { dismissed: true })).toBe(DISMISS_TEXT);
  });

  it("returns one line when every question was skipped", () => {
    expect(
      formatAnswers(set, {
        dismissed: false,
        answers: set.questions.map(() => ({ status: "skipped" as const })),
      }),
    ).toBe(ALL_SKIPPED_TEXT);
  });

  it("treats an answer with nothing picked or typed as skipped", () => {
    expect(
      formatAnswers(set, {
        dismissed: false,
        answers: [
          { status: "answered", selected: [], other: "  \u0007 " },
          { status: "answered", selected: ["Focus"] },
        ],
      }),
    ).toContain(
      "1. Which part should I review?\n   → Skipped. Use your judgment",
    );
  });

  it("cleans typed text and indents its extra lines", () => {
    const text = formatAnswers(set, {
      dismissed: false,
      answers: [
        { status: "skipped" },
        { status: "skipped" },
        { status: "answered", selected: [], other: "first\r\nsecond\u0000\r" },
        { status: "skipped" },
      ],
    });
    expect(text).toContain(
      '3. What should the table be called?\n   → "first\n     second"',
    );
    expect(text).not.toMatch(/[\r\u0000]/);
  });
});
