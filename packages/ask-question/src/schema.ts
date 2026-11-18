/**
 * A JSON schema node, limited to what the tool uses. Every node has a string
 * `type`: Gemini rejects schema nodes without one.
 */
export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
}

export interface AskQuestionParameters {
  type: "object";
  required: string[];
  properties: Record<string, JsonSchema>;
}

/**
 * Limits the model is asked to keep. normalizeQuestionArgs does not enforce
 * them: models that miss a length limit then fail and retry, which costs more
 * than showing a fifth option.
 */
export const SUGGESTED_MAX_QUESTIONS = 4;
export const SUGGESTED_MAX_OPTIONS = 4;
export const SUGGESTED_HEADER_LENGTH = 12;

/** The tool's name in the VS Code extension, like core's other built-ins. */
export const ASK_QUESTION_TOOL_NAME = "ask_question";
/** The tool's name in cn, whose built-in tools are PascalCase. */
export const CLI_ASK_QUESTION_TOOL_NAME = "AskQuestion";

export const ASK_QUESTION_DESCRIPTION = [
  "Ask the user 1 to 4 multiple-choice questions and wait for the answers. Use it when a decision is the user's to make: unclear requirements, a choice between approaches, or a preference you cannot infer from the code. Ask only when the answer changes what you do next.",
  "",
  "- Put all your questions in one call. Each question has 2 to 4 short options, or no options when the answer is free text.",
  '- Put the option you recommend first and add " (Recommended)" to its label.',
  "- Set multiSelect to true when more than one answer can apply.",
  '- Do not add an "Other" option. The user can always type their own answer.',
  "- Don't use it to ask for approval of a plan or to confirm before acting.",
  "- The user may skip a question or dismiss them all. Then continue with your best judgment and state the assumption you make.",
].join("\n");

export const ASK_QUESTION_PARAMETERS: AskQuestionParameters = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      description: `1 to ${SUGGESTED_MAX_QUESTIONS} questions, in the order the user should answer them.`,
      minItems: 1,
      maxItems: SUGGESTED_MAX_QUESTIONS,
      items: {
        type: "object",
        required: ["question", "options"],
        properties: {
          question: {
            type: "string",
            description: "The complete question, ending with a question mark.",
          },
          header: {
            type: "string",
            description: `A very short label shown as a chip, ${SUGGESTED_HEADER_LENGTH} characters or fewer. For example "Scope".`,
          },
          options: {
            type: "array",
            description: `2 to ${SUGGESTED_MAX_OPTIONS} choices, or an empty array when the answer is free text. Don't add "Other": the user can always type their own answer.`,
            maxItems: SUGGESTED_MAX_OPTIONS,
            items: {
              type: "object",
              required: ["label"],
              properties: {
                label: {
                  type: "string",
                  description:
                    'The choice in 1 to 5 words. Put the recommended choice first and end its label with " (Recommended)".',
                },
                description: {
                  type: "string",
                  description:
                    "What the choice means, or what happens if the user picks it.",
                },
              },
            },
          },
          multiSelect: {
            type: "boolean",
            description:
              "true when the user may pick more than one option. Defaults to false.",
          },
        },
      },
    },
  },
};
