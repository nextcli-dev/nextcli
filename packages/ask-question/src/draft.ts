import { cleanText } from "./text.js";
import type {
  AnswerSet,
  Question,
  QuestionAnswer,
  QuestionSet,
} from "./types.js";

/**
 * A question's answer while the user is still working on it. Both the VS Code
 * panel and the cn prompt keep one per question.
 */
export interface QuestionDraft {
  /** Indexes of the picked options. */
  selected: number[];
  /** Text in the "Other" field, or the free-text answer. */
  other: string;
  /** Whether "Other" counts as picked. Typing in the field turns it on. */
  otherOn: boolean;
  skipped: boolean;
}

export function emptyDraft(): QuestionDraft {
  return { selected: [], other: "", otherOn: false, skipped: false };
}

function typedText(question: Question, draft: QuestionDraft): string {
  return question.options.length === 0 || draft.otherOn
    ? cleanText(draft.other)
    : "";
}

/** True once the draft holds a picked option or typed text. */
export function isDraftAnswered(
  question: Question,
  draft: QuestionDraft,
): boolean {
  return draft.selected.length > 0 || typedText(question, draft) !== "";
}

/**
 * Picks option `index`. Single choice replaces the selection and turns "Other"
 * off; multiple choice toggles the option.
 */
export function pickOption(
  question: Question,
  draft: QuestionDraft,
  index: number,
): QuestionDraft {
  if (question.multiSelect) {
    const selected = draft.selected.includes(index)
      ? draft.selected.filter((i) => i !== index)
      : [...draft.selected, index].sort((a, b) => a - b);
    return { ...draft, selected, skipped: false };
  }
  return { ...draft, selected: [index], otherOn: false, skipped: false };
}

/**
 * Sets the "Other" text. Typing turns "Other" on; in single choice it also
 * clears the picked option.
 */
export function typeOther(
  question: Question,
  draft: QuestionDraft,
  text: string,
): QuestionDraft {
  return {
    ...draft,
    other: text,
    otherOn: true,
    selected: question.multiSelect ? draft.selected : [],
    skipped: false,
  };
}

export function skipDraft(): QuestionDraft {
  return { ...emptyDraft(), skipped: true };
}

export function draftToAnswer(
  question: Question,
  draft: QuestionDraft,
): QuestionAnswer {
  if (draft.skipped || !isDraftAnswered(question, draft)) {
    return { status: "skipped" };
  }
  const selected = draft.selected
    .filter((i) => i >= 0 && i < question.options.length)
    .map((i) => question.options[i].label);
  const other = typedText(question, draft);
  return other
    ? { status: "answered", selected, other }
    : { status: "answered", selected };
}

/**
 * The first question that is neither answered nor skipped, or -1. Sending
 * jumps there instead of treating an untouched question as skipped.
 */
export function firstUnanswered(
  set: QuestionSet,
  drafts: QuestionDraft[],
): number {
  return set.questions.findIndex((question, i) => {
    const draft = drafts[i] ?? emptyDraft();
    return !draft.skipped && !isDraftAnswered(question, draft);
  });
}

export function draftsToAnswerSet(
  set: QuestionSet,
  drafts: QuestionDraft[],
): AnswerSet {
  return {
    dismissed: false,
    answers: set.questions.map((question, i) =>
      draftToAnswer(question, drafts[i] ?? emptyDraft()),
    ),
  };
}
