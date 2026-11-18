import { describe, expect, it } from "vitest";

import { AskQuestionArgsError, normalizeQuestionArgs } from "../src/index.js";

const two = [{ label: "Postgres" }, { label: "SQLite" }];

function errorOf(raw: unknown): string {
  try {
    normalizeQuestionArgs(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(AskQuestionArgsError);
    return (e as Error).message;
  }
  throw new Error("expected normalizeQuestionArgs to throw");
}

describe("normalizeQuestionArgs", () => {
  it("keeps a well-formed question set", () => {
    expect(
      normalizeQuestionArgs({
        questions: [
          {
            question: "Which database?",
            header: "Database",
            options: [
              { label: "Postgres (Recommended)", description: "Production" },
              { label: "SQLite" },
            ],
          },
          {
            question: "Which features?",
            options: [{ label: "Auth" }, { label: "Billing" }],
            multiSelect: true,
          },
        ],
      }),
    ).toEqual({
      questions: [
        {
          question: "Which database?",
          header: "Database",
          options: [
            { label: "Postgres (Recommended)", description: "Production" },
            { label: "SQLite" },
          ],
          multiSelect: false,
        },
        {
          question: "Which features?",
          options: [{ label: "Auth" }, { label: "Billing" }],
          multiSelect: true,
        },
      ],
    });
  });

  it("keeps a question with no options as a free-text question", () => {
    expect(
      normalizeQuestionArgs({
        questions: [{ question: "Table name?", options: [] }],
      }).questions[0],
    ).toEqual({ question: "Table name?", options: [], multiSelect: false });
    expect(
      normalizeQuestionArgs({ questions: [{ question: "Table name?" }] })
        .questions[0].options,
    ).toEqual([]);
  });

  it("ignores multiSelect on a free-text question", () => {
    expect(
      normalizeQuestionArgs({
        questions: [{ question: "Name?", options: [], multiSelect: true }],
      }).questions[0].multiSelect,
    ).toBe(false);
  });

  describe("fails only on input it cannot show", () => {
    it.each([
      ["a non-object", 42],
      ["null", null],
      ["an array", []],
    ])("rejects %s", (_name, raw) => {
      expect(errorOf(raw)).toMatch(/must be an object with a "questions"/);
    });

    it("rejects missing or empty questions", () => {
      expect(errorOf({})).toMatch(/Pass at least one question/);
      expect(errorOf({ questions: [] })).toMatch(/Pass at least one question/);
      expect(errorOf({ questions: "not json" })).toMatch(
        /Pass at least one question/,
      );
    });

    it("rejects a question with neither text nor header", () => {
      expect(errorOf({ questions: [{ options: two }] })).toBe(
        'Question 1 has no "question" text. Fix the arguments and call the tool again.',
      );
      expect(
        errorOf({ questions: [{ question: "Ok?" }, { question: "  " }] }),
      ).toMatch(/^Question 2 has no "question" text/);
    });

    it("rejects a question that is not an object or text", () => {
      expect(errorOf({ questions: [7] })).toMatch(
        /^Question 1 must be an object/,
      );
    });

    it("rejects options that are not an array", () => {
      expect(
        errorOf({ questions: [{ question: "Q?", options: { a: 1 } }] }),
      ).toMatch(/^Question 1: "options" must be an array/);
    });

    it("rejects an option without a label", () => {
      expect(
        errorOf({
          questions: [{ question: "Q?", options: [{ label: "A" }, {}] }],
        }),
      ).toMatch(/^Question 1, option 2 has no "label"/);
      expect(
        errorOf({ questions: [{ question: "Q?", options: ["A", "  "] }] }),
      ).toMatch(/^Question 1, option 2 has no "label"/);
    });
  });

  describe("repairs cosmetic problems without an error", () => {
    it("uses the header when the question text is missing", () => {
      expect(
        normalizeQuestionArgs({
          questions: [{ header: "Which database?", options: two }],
        }).questions[0],
      ).toEqual({
        question: "Which database?",
        options: two,
        multiSelect: false,
      });
    });

    it("keeps long headers; the UI shortens them", () => {
      const header = "A header far longer than twelve characters";
      expect(
        normalizeQuestionArgs({
          questions: [{ question: "Q?", header, options: two }],
        }).questions[0].header,
      ).toBe(header);
    });

    it("drops the Other options the UI already offers and keeps None", () => {
      const labels = normalizeQuestionArgs({
        questions: [
          {
            question: "Q?",
            options: [
              "Postgres",
              "Other",
              "None of the above",
              "other (please specify)",
              "None.",
              "Something else:",
              "Other databases",
            ],
          },
        ],
      }).questions[0].options.map((o) => o.label);
      // "None" is an answer the user picks; "Other" would show up twice
      expect(labels).toEqual([
        "Postgres",
        "None of the above",
        "None.",
        "Other databases",
      ]);
    });

    it("asks for free text when the only options are Other", () => {
      expect(
        normalizeQuestionArgs({
          questions: [
            { question: "Which service?", options: ["Other (specify)"] },
          ],
        }).questions[0],
      ).toEqual({
        question: "Which service?",
        options: [],
        multiSelect: false,
      });
    });

    it("drops repeated labels and keeps the first", () => {
      expect(
        normalizeQuestionArgs({
          questions: [
            {
              question: "Q?",
              options: [
                { label: "Postgres", description: "first" },
                { label: "postgres", description: "second" },
                { label: "SQLite" },
              ],
            },
          ],
        }).questions[0].options,
      ).toEqual([
        { label: "Postgres", description: "first" },
        { label: "SQLite" },
      ]);
    });

    it("shows more than the suggested number of questions and options", () => {
      const options = ["a", "b", "c", "d", "e", "f"];
      const set = normalizeQuestionArgs({
        questions: Array.from({ length: 6 }, (_, i) => ({
          question: `Q${i}?`,
          options,
        })),
      });
      expect(set.questions).toHaveLength(6);
      expect(set.questions[0].options).toHaveLength(6);
    });

    it("shows a single option next to the UI's Other answer", () => {
      expect(
        normalizeQuestionArgs({
          questions: [{ question: "Q?", options: ["Yes"] }],
        }).questions[0].options,
      ).toEqual([{ label: "Yes" }]);
    });

    it("accepts string, number and boolean options", () => {
      expect(
        normalizeQuestionArgs({
          questions: [{ question: "Q?", options: ["npm", 3, true] }],
        }).questions[0].options,
      ).toEqual([{ label: "npm" }, { label: "3" }, { label: "true" }]);
    });

    it("accepts multiple as an alias of multiSelect, and the string true", () => {
      const [a, b] = normalizeQuestionArgs({
        questions: [
          { question: "A?", options: two, multiple: true },
          { question: "B?", options: two, multiSelect: "true" },
        ],
      }).questions;
      expect(a.multiSelect).toBe(true);
      expect(b.multiSelect).toBe(true);
    });

    it("parses questions and options sent as JSON strings", () => {
      expect(
        normalizeQuestionArgs({
          questions: JSON.stringify([
            { question: "Q?", options: JSON.stringify(["a", "b"]) },
          ]),
        }).questions[0].options,
      ).toEqual([{ label: "a" }, { label: "b" }]);
      expect(
        normalizeQuestionArgs(
          JSON.stringify({ questions: [{ question: "Q?" }] }),
        ).questions,
      ).toHaveLength(1);
    });

    it("accepts a single question object instead of an array", () => {
      expect(
        normalizeQuestionArgs({ questions: { question: "Q?", options: two } })
          .questions,
      ).toHaveLength(1);
    });

    it("accepts a question given as plain text", () => {
      expect(normalizeQuestionArgs({ questions: ["Table name?"] })).toEqual({
        questions: [
          { question: "Table name?", options: [], multiSelect: false },
        ],
      });
    });

    it("accepts the old cn shape and ignores defaultAnswer", () => {
      expect(
        normalizeQuestionArgs({
          question: "Which package manager?",
          options: ["npm", "pnpm"],
          defaultAnswer: "npm",
        }),
      ).toEqual({
        questions: [
          {
            question: "Which package manager?",
            options: [{ label: "npm" }, { label: "pnpm" }],
            multiSelect: false,
          },
        ],
      });
    });

    it("cleans control characters and whitespace", () => {
      const [q] = normalizeQuestionArgs({
        questions: [
          {
            question: "  Which\r\ndatabase?\u0007 ",
            header: "Data\nbase",
            options: [{ label: " Post\tgres\r\n", description: "fast\r\n" }],
          },
        ],
      }).questions;
      expect(q.question).toBe("Which\ndatabase?");
      expect(q.header).toBe("Data base");
      expect(q.options).toEqual([{ label: "Post gres", description: "fast" }]);
    });
  });
});
