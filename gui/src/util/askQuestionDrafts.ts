import {
  FormState,
  initialFormState,
  QuestionSet,
} from "@nextcli/ask-question";

// Kept outside React so half-finished answers survive the panel unmounting,
// for example when the user switches to another session and back. A webview
// reload clears them; the question itself stays open in the saved session.
const drafts = new Map<string, FormState>();

export function loadQuestionDraft(
  toolCallId: string,
  set: QuestionSet,
): FormState {
  const saved = drafts.get(toolCallId);
  if (saved && saved.drafts.length === set.questions.length) return saved;
  return initialFormState(set);
}

export function saveQuestionDraft(toolCallId: string, form: FormState) {
  drafts.set(toolCallId, form);
}

export function clearQuestionDraft(toolCallId: string) {
  drafts.delete(toolCallId);
}
