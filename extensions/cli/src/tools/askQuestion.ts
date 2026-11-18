import {
  ASK_QUESTION_DESCRIPTION,
  ASK_QUESTION_PARAMETERS,
  CLI_ASK_QUESTION_TOOL_NAME,
  formatAnswers,
  normalizeQuestionArgs,
  QuestionSet,
} from "@nextcli/ask-question";

import { quizService } from "../services/QuizService.js";

import { Tool } from "./types.js";

/**
 * Asks the person at the terminal 1 to 4 questions. The contract (arguments,
 * repairs, the answer text) is shared with the VS Code extension's
 * ask_question tool through @nextcli/ask-question.
 */
export const askQuestionTool: Tool = {
  name: CLI_ASK_QUESTION_TOOL_NAME,
  displayName: "Ask Question",
  description: ASK_QUESTION_DESCRIPTION,
  parameters: ASK_QUESTION_PARAMETERS,
  readonly: true,
  isBuiltIn: true,
  // Only input the prompt cannot show fails here; the model gets the message.
  preprocess: async (args) => ({ args: { ...normalizeQuestionArgs(args) } }),
  run: async (set: QuestionSet, context) => {
    const answers = await quizService.askQuestions(set, context?.signal);
    return formatAnswers(set, answers);
  },
};
