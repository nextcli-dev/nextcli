/** One choice the user can pick. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/**
 * A question after normalizeQuestionArgs. A question with no options asks for
 * a free-text answer. Every UI adds an "Other" free-text answer to the rest.
 */
export interface Question {
  question: string;
  /** Short label shown as a chip. */
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface QuestionSet {
  questions: Question[];
}

export type QuestionAnswer =
  | {
      status: "answered";
      /** Labels of the picked options, in option order. */
      selected: string[];
      /** What the user typed as "Other", or the free-text answer. */
      other?: string;
    }
  | { status: "skipped" };

/** The user either dismissed every question or answered or skipped each one. */
export type AnswerSet =
  | { dismissed: true }
  | { dismissed: false; answers: QuestionAnswer[] };
