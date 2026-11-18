import { describe, expect, it } from "vitest";

import {
  draftToAnswer,
  draftsToAnswerSet,
  emptyDraft,
  firstUnanswered,
  isDraftAnswered,
  normalizeQuestionArgs,
  pickOption,
  skipDraft,
  typeOther,
} from "../src/index.js";

const [single, multi, free] = normalizeQuestionArgs({
  questions: [
    { question: "One?", options: ["a", "b", "c"] },
    { question: "Many?", options: ["x", "y", "z"], multiSelect: true },
    { question: "Free?", options: [] },
  ],
}).questions;

describe("drafts", () => {
  it("single choice keeps one option and turns Other off", () => {
    let d = pickOption(single, emptyDraft(), 0);
    d = pickOption(single, d, 2);
    expect(d.selected).toEqual([2]);
    d = typeOther(single, d, "mine");
    expect(d).toMatchObject({ selected: [], otherOn: true, other: "mine" });
    d = pickOption(single, d, 1);
    expect(d).toMatchObject({ selected: [1], otherOn: false, other: "mine" });
    expect(draftToAnswer(single, d)).toEqual({
      status: "answered",
      selected: ["b"],
    });
  });

  it("multiple choice toggles options and keeps Other alongside", () => {
    let d = pickOption(multi, emptyDraft(), 2);
    d = pickOption(multi, d, 0);
    d = typeOther(multi, d, "w");
    expect(draftToAnswer(multi, d)).toEqual({
      status: "answered",
      selected: ["x", "z"],
      other: "w",
    });
    d = pickOption(multi, d, 0);
    expect(d.selected).toEqual([2]);
  });

  it("counts typed text only when it has content", () => {
    expect(isDraftAnswered(single, typeOther(single, emptyDraft(), "  "))).toBe(
      false,
    );
    expect(isDraftAnswered(free, { ...emptyDraft(), other: "name" })).toBe(
      true,
    );
    expect(draftToAnswer(free, { ...emptyDraft(), other: " name " })).toEqual({
      status: "answered",
      selected: [],
      other: "name",
    });
  });

  it("reports skipped and untouched questions", () => {
    expect(draftToAnswer(single, skipDraft())).toEqual({ status: "skipped" });
    const set = { questions: [single, multi, free] };
    const drafts = [
      pickOption(single, emptyDraft(), 0),
      skipDraft(),
      emptyDraft(),
    ];
    expect(firstUnanswered(set, drafts)).toBe(2);
    drafts[2] = { ...emptyDraft(), other: "x" };
    expect(firstUnanswered(set, drafts)).toBe(-1);
    expect(draftsToAnswerSet(set, drafts)).toEqual({
      dismissed: false,
      answers: [
        { status: "answered", selected: ["a"] },
        { status: "skipped" },
        { status: "answered", selected: [], other: "x" },
      ],
    });
  });
});
