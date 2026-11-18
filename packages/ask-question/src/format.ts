import { cleanText } from "./text.js";
import type { AnswerSet, QuestionAnswer, QuestionSet } from "./types.js";

export const DISMISS_TEXT =
  "The user dismissed your questions without answering and will reply in the chat.";

export const ALL_SKIPPED_TEXT =
  "The user skipped your questions. Use your judgment and state the assumptions you make.";

const SKIPPED_LINE =
  "Skipped. Use your judgment and state the assumption you make.";

/** Indents every line after the first, so multi-line text keeps the layout. */
function indentRest(text: string, indent: string): string {
  return text.replace(/\n/g, `\n${indent}`);
}

function quote(text: string): string {
  return `"${indentRest(text, "     ")}"`;
}

/** Treats an answer with nothing picked and nothing typed as skipped. */
function effective(answer: QuestionAnswer | undefined): QuestionAnswer {
  if (!answer || answer.status === "skipped") return { status: "skipped" };
  const other = answer.other === undefined ? "" : cleanText(answer.other);
  if (answer.selected.length === 0 && !other) return { status: "skipped" };
  return other
    ? { status: "answered", selected: answer.selected, other }
    : { status: "answered", selected: answer.selected };
}

/**
 * The tool result the model reads. Picked options and typed answers are on
 * separate lines, so the model can tell them apart.
 */
export function formatAnswers(set: QuestionSet, result: AnswerSet): string {
  if (result.dismissed) return DISMISS_TEXT;
  const answers = set.questions.map((_, i) => effective(result.answers[i]));
  if (answers.every((answer) => answer.status === "skipped")) {
    return ALL_SKIPPED_TEXT;
  }
  const lines = [
    set.questions.length === 1
      ? "The user answered your question:"
      : "The user answered your questions:",
  ];
  set.questions.forEach((question, i) => {
    const answer = answers[i];
    const multiple = question.multiSelect ? " (multiple choice)" : "";
    lines.push(`${i + 1}. ${indentRest(question.question, "   ")}${multiple}`);
    if (answer.status === "skipped") {
      lines.push(`   → ${SKIPPED_LINE}`);
      return;
    }
    if (question.options.length === 0) {
      lines.push(`   → ${quote(answer.other ?? "")}`);
      return;
    }
    if (answer.selected.length) {
      lines.push(`   → ${answer.selected.join("; ")}`);
    }
    if (answer.other) lines.push(`   → Other: ${quote(answer.other)}`);
  });
  return lines.join("\n");
}
