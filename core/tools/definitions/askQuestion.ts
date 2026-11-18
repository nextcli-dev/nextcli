import {
  ASK_QUESTION_DESCRIPTION,
  ASK_QUESTION_PARAMETERS,
  normalizeQuestionArgs,
} from "@nextcli/ask-question";

import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

/**
 * Runs in the webview (it is in CLIENT_TOOLS_IMPLS): the call stays in
 * "calling" until the user answers the panel that replaces the chat input.
 * It is read-only, so plan mode offers it too, and it needs no approval,
 * because asking permission to ask a question adds nothing.
 */
export const askQuestionTool: Tool = {
  type: "function",
  displayTitle: "Ask Question",
  wouldLikeTo: "ask you a question",
  isCurrently: "waiting for your answer",
  hasAlready: "asked you a question",
  readonly: true,
  isInstant: false,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.AskQuestion,
    description: ASK_QUESTION_DESCRIPTION,
    parameters: ASK_QUESTION_PARAMETERS,
  },
  systemMessageDescription: {
    prefix: `To ask the user questions when a decision is theirs to make, use the ${BuiltInToolNames.AskQuestion} tool with an array of 1 to 4 questions. Each question has 2 to 4 short options, or none for a free-text answer; the user can always type their own answer, so don't add an "Other" option. For example:`,
    exampleArgs: [
      [
        "questions",
        `[
  {
    "question": "Which database should the service use?",
    "header": "Database",
    "options": [
      { "label": "Postgres (Recommended)", "description": "Matches production" },
      { "label": "SQLite", "description": "No server to run" }
    ]
  },
  {
    "question": "Which endpoints need authentication?",
    "header": "Auth",
    "multiSelect": true,
    "options": [{ "label": "Read" }, { "label": "Write" }, { "label": "Admin" }]
  }
]`,
      ],
    ],
  },
  defaultToolPolicy: "allowedWithoutPermission",
  // Validates and repairs the arguments. Only input the panel cannot show
  // throws; the GUI then marks the call errored with the message for the model.
  preprocessArgs: async (args) => ({ ...normalizeQuestionArgs(args) }),
};
