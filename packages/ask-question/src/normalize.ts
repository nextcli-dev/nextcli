import { cleanLine, cleanText } from "./text.js";
import type { Question, QuestionOption, QuestionSet } from "./types.js";

/**
 * Thrown for arguments the tool cannot show at all. The message is written for
 * the model, which gets it as the tool result.
 */
export class AskQuestionArgsError extends Error {
  constructor(problem: string) {
    super(`${problem} Fix the arguments and call the tool again.`);
    this.name = "AskQuestionArgsError";
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Models sometimes send an array or object argument as a JSON string. */
function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

// "Other", "None of the above", "Other (please specify)" and the like. Every UI
// adds its own "Other" answer, so a model-made one would show up twice.
const CATCH_ALL_LABEL = /^(other|none|none of the above|something else)$/;

function isCatchAll(label: string): boolean {
  const core = label
    .toLowerCase()
    .replace(/\s*\(.*\)\s*$/, "")
    .replace(/[\s.:…!]+$/, "");
  return CATCH_ALL_LABEL.test(core);
}

function optionLabel(option: unknown): string {
  if (typeof option === "string") return cleanLine(option);
  if (typeof option === "number" || typeof option === "boolean") {
    return String(option);
  }
  if (isRecord(option) && typeof option.label === "string") {
    return cleanLine(option.label);
  }
  return "";
}

function normalizeOptions(raw: unknown, n: number): QuestionOption[] {
  const list = parseJsonString(raw);
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    throw new AskQuestionArgsError(
      `Question ${n}: "options" must be an array.`,
    );
  }
  const options: QuestionOption[] = [];
  const seen = new Set<string>();
  list.forEach((option, j) => {
    const label = optionLabel(option);
    if (!label) {
      throw new AskQuestionArgsError(
        `Question ${n}, option ${j + 1} has no "label".`,
      );
    }
    if (isCatchAll(label)) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const description =
      isRecord(option) && typeof option.description === "string"
        ? cleanText(option.description)
        : "";
    options.push(description ? { label, description } : { label });
  });
  return options;
}

function normalizeQuestion(raw: unknown, n: number): Question {
  if (typeof raw === "string" && cleanText(raw)) {
    return { question: cleanText(raw), options: [], multiSelect: false };
  }
  if (!isRecord(raw)) {
    throw new AskQuestionArgsError(
      `Question ${n} must be an object with "question" and "options".`,
    );
  }
  const header = typeof raw.header === "string" ? cleanLine(raw.header) : "";
  const text = typeof raw.question === "string" ? cleanText(raw.question) : "";
  if (!text && !header) {
    throw new AskQuestionArgsError(`Question ${n} has no "question" text.`);
  }
  const options = normalizeOptions(raw.options, n);
  const multi = raw.multiSelect ?? raw.multiple;
  const question: Question = {
    // A question without text but with a header is still worth asking.
    question: text || header,
    options,
    multiSelect: options.length > 0 && (multi === true || multi === "true"),
  };
  if (text && header) question.header = header;
  return question;
}

/**
 * Turns the model's arguments into questions the UIs can show. Only input that
 * cannot be shown fails. Everything else is repaired without an error: models
 * that fail on a cosmetic limit retry, and the retries cost more than the
 * repair. Accepted on top of the documented schema:
 * - `questions` as a JSON string, or a single question object;
 * - the old cn shape `{question, options: string[]}`;
 * - options as strings; `multiple` as an alias of `multiSelect`;
 * - a missing `question` when there is a `header`.
 * Catch-all options ("Other", "None of the above") and repeated labels are
 * dropped, and the suggested limits on counts and lengths are not enforced.
 */
export function normalizeQuestionArgs(raw: unknown): QuestionSet {
  const args = parseJsonString(raw);
  if (!isRecord(args)) {
    throw new AskQuestionArgsError(
      'The arguments must be an object with a "questions" array.',
    );
  }
  let list = parseJsonString(args.questions);
  if (list === undefined && typeof args.question === "string") {
    list = [args];
  }
  if (isRecord(list)) list = [list];
  if (!Array.isArray(list) || list.length === 0) {
    throw new AskQuestionArgsError(
      'Pass at least one question in "questions", for example {"questions": [{"question": "Which database should I use?", "options": [{"label": "Postgres"}, {"label": "SQLite"}]}]}.',
    );
  }
  return {
    questions: list.map((question, i) => normalizeQuestion(question, i + 1)),
  };
}
