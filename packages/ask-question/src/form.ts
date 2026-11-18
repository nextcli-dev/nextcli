import {
  draftsToAnswerSet,
  emptyDraft,
  firstUnanswered,
  isDraftAnswered,
  pickOption,
  skipDraft,
  typeOther,
  type QuestionDraft,
} from "./draft.js";
import type { AnswerSet, Question, QuestionSet } from "./types.js";

/**
 * The question form both prompts run: the VS Code panel and the cn prompt map
 * their keys and clicks to `FormEvent`s and render the `FormState` they get
 * back, so paging, picking, skipping and sending work the same in both.
 */

/** Highest option a number key can pick. */
export const MAX_NUMBER_KEY = 9;

export interface FormState {
  /** One draft per question. */
  drafts: QuestionDraft[];
  /** The question on screen. */
  page: number;
  /** Highlighted row per question; the row after the options is "Other". */
  highlight: number[];
  /** Keys go to the "Other" field, or to the answer of a free-text question. */
  editing: boolean;
  /** Why the last Next or Send didn't move on; empty otherwise. */
  warning: string;
}

export type FormEvent =
  /** ↑/↓ over the rows. From the "Other" field, ↑ goes back to the options. */
  | { type: "move"; delta: 1 | -1 }
  /** ←/→ outside a text field, or the previous and next buttons. */
  | { type: "page"; delta: 1 | -1 }
  /**
   * A click or a number key on option `index`. In single choice it answers
   * the question and moves on, sending after the last one.
   */
  | { type: "pick"; index: number }
  /** Space: picks or toggles the highlighted option without moving on. */
  | { type: "toggle" }
  | { type: "enter" }
  /** The whole "Other" (or free-text) answer after an edit. */
  | { type: "type"; text: string }
  /** Moves into the "Other" field; the draft changes once text is typed. */
  | { type: "editOther" }
  /** Esc: leaves the "Other" field, or else skips the question. */
  | { type: "escape" }
  | { type: "skip" }
  /** The Next or Send button. */
  | { type: "next" };

export interface FormStep {
  state: FormState;
  /** Set when the form is done and the answers should be sent. */
  answers?: AnswerSet;
}

export function initialFormState(set: QuestionSet): FormState {
  return {
    drafts: set.questions.map(() => emptyDraft()),
    page: 0,
    highlight: set.questions.map(() => 0),
    editing: set.questions[0]?.options.length === 0,
    warning: "",
  };
}

function replaceAt<T>(list: T[], index: number, value: T): T[] {
  return list.map((item, i) => (i === index ? value : item));
}

function unansweredWarning(question: Question): string {
  if (question.options.length === 0) {
    return "Type an answer, or press Esc to skip.";
  }
  return question.multiSelect
    ? "Pick at least one option, or press Esc to skip."
    : "Pick an option, or press Esc to skip.";
}

function withCurrent(
  state: FormState,
  draft: QuestionDraft,
  highlight = state.highlight[state.page] ?? 0,
): FormState {
  return {
    ...state,
    drafts: replaceAt(state.drafts, state.page, draft),
    highlight: replaceAt(state.highlight, state.page, highlight),
  };
}

function onPage(
  set: QuestionSet,
  state: FormState,
  page: number,
  warning = "",
): FormState {
  return {
    ...state,
    page,
    editing: set.questions[page].options.length === 0,
    warning,
  };
}

/** Moves on from the current question, or sends after the last one. */
function advance(set: QuestionSet, state: FormState): FormStep {
  if (state.page < set.questions.length - 1) {
    return { state: onPage(set, state, state.page + 1) };
  }
  const missing = firstUnanswered(set, state.drafts);
  if (missing >= 0) {
    return {
      state: onPage(
        set,
        state,
        missing,
        `Answer or skip question ${missing + 1} first.`,
      ),
    };
  }
  return {
    state: { ...state, warning: "" },
    answers: draftsToAnswerSet(set, state.drafts),
  };
}

function next(set: QuestionSet, state: FormState): FormStep {
  const question = set.questions[state.page];
  if (!isDraftAnswered(question, state.drafts[state.page])) {
    return { state: { ...state, warning: unansweredWarning(question) } };
  }
  return advance(set, state);
}

function pick(
  set: QuestionSet,
  state: FormState,
  index: number,
  thenAdvance: boolean,
): FormStep {
  const question = set.questions[state.page];
  if (index < 0 || index >= question.options.length) return { state };
  const picked = {
    ...withCurrent(
      state,
      pickOption(question, state.drafts[state.page], index),
      index,
    ),
    editing: false,
    warning: "",
  };
  return thenAdvance && !question.multiSelect
    ? advance(set, picked)
    : { state: picked };
}

export function reduceForm(
  set: QuestionSet,
  state: FormState,
  event: FormEvent,
): FormStep {
  const question = set.questions[state.page];
  const draft = state.drafts[state.page];
  const optionCount = question.options.length;
  const highlight = state.highlight[state.page] ?? 0;
  const editing = optionCount === 0 || state.editing;

  switch (event.type) {
    case "move": {
      if (optionCount === 0) return { state };
      if (editing) {
        if (event.delta > 0) return { state };
        return {
          state: {
            ...withCurrent(state, draft, optionCount - 1),
            editing: false,
          },
        };
      }
      const row = Math.max(0, Math.min(optionCount, highlight + event.delta));
      return {
        state: {
          ...withCurrent(state, draft, row),
          editing: row === optionCount,
          warning: "",
        },
      };
    }
    case "page": {
      const page = state.page + event.delta;
      if (page < 0 || page >= set.questions.length) return { state };
      return { state: onPage(set, state, page) };
    }
    case "pick":
      return pick(set, state, event.index, true);
    case "toggle":
      if (highlight < optionCount) {
        return pick(set, state, highlight, false);
      }
      return { state: { ...state, editing: true } };
    case "enter":
      if (editing || question.multiSelect) return next(set, state);
      if (highlight < optionCount) return pick(set, state, highlight, true);
      return { state: { ...state, editing: true } };
    case "type":
      return {
        state: {
          ...withCurrent(
            state,
            typeOther(question, draft, event.text),
            optionCount,
          ),
          editing: true,
          warning: "",
        },
      };
    case "editOther":
      return {
        state: { ...withCurrent(state, draft, optionCount), editing: true },
      };
    case "escape":
      if (editing && optionCount > 0) {
        return {
          state: {
            ...withCurrent(state, draft, optionCount),
            editing: false,
          },
        };
      }
      return advance(set, withCurrent(state, skipDraft()));
    case "skip":
      return advance(set, withCurrent(state, skipDraft()));
    case "next":
      return next(set, state);
  }
}
