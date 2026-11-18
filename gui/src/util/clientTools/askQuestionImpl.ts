import { ClientToolImpl } from "./callClientTool";

/**
 * Leaves the call in "calling" and returns without output. The panel that
 * replaces the chat input finishes the call when the user answers or
 * dismisses it (redux/thunks/answerQuestion.ts).
 */
export const askQuestionImpl: ClientToolImpl = async () => ({
  respondImmediately: false,
  output: undefined,
});
