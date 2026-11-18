import { emptyDraft, QuestionDraft } from "@nextcli/ask-question";

/** What the question panel needs to pick up where the user left off. */
export interface PanelDraft {
  drafts: QuestionDraft[];
  /** The question on screen. */
  page: number;
  /** Highlighted row per question; the row after the options is "Other". */
  highlight: number[];
}

// Kept outside React so half-finished answers survive the panel unmounting,
// for example when the user switches to another session and back. A webview
// reload clears it.
const drafts = new Map<string, PanelDraft>();

export function loadQuestionDraft(
  toolCallId: string,
  questionCount: number,
): PanelDraft {
  const saved = drafts.get(toolCallId);
  if (saved && saved.drafts.length === questionCount) return saved;
  return {
    drafts: Array.from({ length: questionCount }, emptyDraft),
    page: 0,
    highlight: Array.from({ length: questionCount }, () => 0),
  };
}

export function saveQuestionDraft(toolCallId: string, draft: PanelDraft) {
  drafts.set(toolCallId, draft);
}

export function clearQuestionDraft(toolCallId: string) {
  drafts.delete(toolCallId);
}
