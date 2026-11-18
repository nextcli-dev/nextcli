import { Editor } from "@tiptap/react";

/** Marks the question panel, which takes the chat input's place while open. */
export const QUESTION_PANEL_ATTRIBUTE = "data-ask-question-panel";

export function openQuestionPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${QUESTION_PANEL_ATTRIBUTE}]`);
}

/**
 * Focuses the chat input: the open question panel when there is one (the
 * editor stays mounted but hidden under it), otherwise the editor.
 */
export function focusChatInput(
  editor: Editor | null | undefined,
  position?: Parameters<Editor["commands"]["focus"]>[0],
) {
  const panel = openQuestionPanel();
  if (panel) {
    panel.focus({ preventScroll: true });
    return;
  }
  editor?.commands.focus(position);
}
