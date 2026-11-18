import { describe, expect, it } from "vitest";

import {
  type FormEvent,
  type FormState,
  initialFormState,
  normalizeQuestionArgs,
  type QuestionSet,
  reduceForm,
} from "../src/index.js";

const three = normalizeQuestionArgs({
  questions: [
    { question: "One?", options: ["a", "b", "c"] },
    { question: "Many?", options: ["x", "y", "z"], multiSelect: true },
    { question: "Free?", options: [] },
  ],
});
const lone = normalizeQuestionArgs({
  questions: [{ question: "Only?", options: ["yes", "no"] }],
});

/** Runs events in order; returns the last state and any answers sent. */
function run(set: QuestionSet, events: FormEvent[], start?: FormState) {
  let state = start ?? initialFormState(set);
  for (const event of events) {
    const step = reduceForm(set, state, event);
    if (step.answers) return { state: step.state, answers: step.answers };
    state = step.state;
  }
  return { state, answers: undefined };
}

describe("question form", () => {
  it("answers a single-choice question and moves on with a pick", () => {
    const { state } = run(three, [{ type: "pick", index: 1 }]);
    expect(state.page).toBe(1);
    expect(state.drafts[0].selected).toEqual([1]);
  });

  it("sends a lone single-choice question on a pick", () => {
    expect(run(lone, [{ type: "pick", index: 1 }]).answers).toEqual({
      dismissed: false,
      answers: [{ status: "answered", selected: ["no"] }],
    });
  });

  it("toggles in multiple choice without moving on", () => {
    const { state } = run(three, [
      { type: "pick", index: 0 }, // answers question 1 and moves on
      { type: "pick", index: 2 },
      { type: "pick", index: 0 },
      { type: "pick", index: 0 },
    ]);
    expect(state.page).toBe(1);
    expect(state.drafts[1].selected).toEqual([2]);
  });

  it("ignores a pick past the last option", () => {
    const start = initialFormState(lone);
    expect(reduceForm(lone, start, { type: "pick", index: 5 }).state).toBe(
      start,
    );
  });

  it("selects with Space and answers with Enter", () => {
    const selected = run(three, [
      { type: "move", delta: 1 },
      { type: "toggle" },
    ]);
    expect(selected.state).toMatchObject({ page: 0 });
    expect(selected.state.drafts[0].selected).toEqual([1]);
    expect(run(three, [{ type: "enter" }], selected.state).state.page).toBe(1);
  });

  it("warns instead of moving on from an unanswered question", () => {
    const { state } = run(three, [{ type: "next" }]);
    expect(state.page).toBe(0);
    expect(state.warning).toBe("Pick an option, or press Esc to skip.");
    // Moving the highlight clears the warning
    expect(run(three, [{ type: "move", delta: 1 }], state).state.warning).toBe(
      "",
    );
  });

  it("jumps to a question left open instead of sending", () => {
    const { state, answers } = run(three, [
      { type: "page", delta: 1 },
      { type: "page", delta: 1 },
      { type: "type", text: "notes" },
      { type: "enter" },
    ]);
    expect(answers).toBeUndefined();
    expect(state.page).toBe(0);
    expect(state.warning).toBe("Answer or skip question 1 first.");
  });

  it("sends once every question is answered or skipped", () => {
    expect(
      run(three, [
        { type: "pick", index: 0 },
        { type: "skip" },
        { type: "type", text: "notes" },
        { type: "enter" },
      ]).answers,
    ).toEqual({
      dismissed: false,
      answers: [
        { status: "answered", selected: ["a"] },
        { status: "skipped" },
        { status: "answered", selected: [], other: "notes" },
      ],
    });
  });

  it("leaves the Other field with Esc and skips with the next Esc", () => {
    const typed = run(three, [{ type: "type", text: "mine" }]).state;
    expect(typed).toMatchObject({ editing: true, highlight: [3, 0, 0] });
    const left = run(three, [{ type: "escape" }], typed).state;
    expect(left).toMatchObject({ editing: false, page: 0 });
    expect(left.drafts[0]).toMatchObject({ other: "mine", otherOn: true });
    const skipped = run(three, [{ type: "escape" }], left).state;
    expect(skipped.page).toBe(1);
    expect(skipped.drafts[0].skipped).toBe(true);
  });

  it("goes back to the options with up from the Other field", () => {
    const { state } = run(three, [
      { type: "editOther" },
      { type: "move", delta: -1 },
    ]);
    expect(state).toMatchObject({ editing: false, highlight: [2, 0, 0] });
  });

  it("enters the Other field without dropping the picked option", () => {
    const picked = run(three, [{ type: "toggle" }]).state;
    const { state } = run(three, [{ type: "editOther" }], picked);
    expect(state.editing).toBe(true);
    expect(state.drafts[0]).toMatchObject({ selected: [0], otherOn: false });
  });

  it("moves onto the Other row and starts editing", () => {
    const { state } = run(three, [
      { type: "move", delta: 1 },
      { type: "move", delta: 1 },
      { type: "move", delta: 1 },
    ]);
    expect(state).toMatchObject({ editing: true, highlight: [3, 0, 0] });
  });

  it("keeps drafts across pages and edits a free-text page", () => {
    const { state } = run(three, [
      { type: "toggle" },
      { type: "page", delta: 1 },
      { type: "page", delta: 1 },
    ]);
    expect(state).toMatchObject({ page: 2, editing: true });
    const back = run(three, [{ type: "page", delta: -1 }], state).state;
    expect(back).toMatchObject({ page: 1, editing: false });
    expect(back.drafts[0].selected).toEqual([0]);
    // No page before the first or after the last
    const first = initialFormState(three);
    expect(reduceForm(three, first, { type: "page", delta: -1 }).state).toBe(
      first,
    );
  });
});
