import { describe, expect, it } from "vitest";
import { questionFromArgs } from "./AskQuestionPanel";

describe("questionFromArgs", () => {
  it("returns questions the panel can show", () => {
    const result = questionFromArgs({
      questions: [{ question: "Which database?", options: ["Postgres"] }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.set.questions[0]?.question).toBe("Which database?");
    }
  });

  it("returns the normalizer's message when the arguments cannot be shown", () => {
    const result = questionFromArgs({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Pass at least one question");
    }
  });

  it("lets an unexpected failure reach the caller", () => {
    const raw = new Proxy(
      {},
      {
        get() {
          throw new TypeError("boom");
        },
      },
    );
    expect(() => questionFromArgs(raw)).toThrow(TypeError);
  });
});
