import { ChatMessage, ILLM } from "..";
import { stripImages } from "./messageContent";

export interface CompactionParams {
  /**
   * The conversation to summarize, built by the GUI with constructMessages:
   * attached context, tool results and any earlier summary, without the
   * agent prompt, rules or tools
   */
  messages: ChatMessage[];
  currentModel: ILLM;
  signal: AbortSignal;
}

export interface CompactionResult {
  summary: string;
  /** Tool outputs cut down so the request fits the model's window */
  shortenedOutputs: number;
}

const COMPACTION_PROMPT: ChatMessage = {
  role: "user",
  content:
    "Create a comprehensive summary of this conversation that captures all essential information needed to continue the work seamlessly. Structure your response to preserve technical accuracy and context continuity.\n\nYour summary should include:\n\n1. **Conversation Overview**: Describe the main topic and progression of the discussion, including any shifts in focus or direction.\n\n2. **Active Development**: Detail what was being implemented, modified, or debugged most recently. Include specific technical approaches and methodologies used.\n\n3. **Technical Stack**: List all relevant technologies, frameworks, libraries, coding patterns, and architectural decisions discussed.\n\n4. **File Operations**: Document all files that were created, modified, or referenced, including their purposes and key changes. Include important code snippets and their locations.\n\n5. **Solutions & Troubleshooting**: Summarize problems encountered and how they were resolved, including any debugging steps or workarounds applied.\n\n6. **Outstanding Work**: Clearly identify any incomplete tasks, pending implementations, or next steps that were discussed. Include direct references to user requests and current progress.\n\nIf there's a previous summary in the conversation, integrate its relevant information while removing outdated details. Focus on technical precision and include specific identifiers (file paths, function names, class names, etc.) that would be essential for continuation. Write in third person and maintain an objective, technical tone.",
};

// Tool outputs are cut to one cap, close to the largest that fits, but never
// below this floor
const MIN_OUTPUT_CHARS = 500;
// An output is cut only when that saves more than the truncation note adds
const TRUNCATION_NOTE_ROOM = 100;

const TOO_LONG_TO_SUMMARIZE =
  "The conversation is too long to summarize in this model's window, even with tool outputs shortened; it was left as it is.";

/** Whether the model sends these messages whole, without dropping old ones */
function fits(model: ILLM, messages: ChatMessage[]): boolean {
  try {
    return !model.compileChatMessages(messages, {}).didPrune;
  } catch (e) {
    // The system message and the newest message alone don't fit
    if (e instanceof Error && e.message.includes("Not enough context")) {
      return false;
    }
    throw e;
  }
}

/** The messages with each tool output longer than the cap cut to it */
function withCap(
  messages: ChatMessage[],
  cap: number,
): { messages: ChatMessage[]; shortened: number } {
  let shortened = 0;
  const capped = messages.map((message) => {
    if (
      message.role !== "tool" ||
      message.content.length <= cap + TRUNCATION_NOTE_ROOM
    ) {
      return message;
    }
    shortened++;
    const removed = message.content.length - cap;
    return {
      ...message,
      content: `${message.content.slice(0, cap)}\n\n(${removed} characters of tool output truncated)`,
    };
  });
  return { messages: capped, shortened };
}

/**
 * The summary request, fitted to the model's window. The model would
 * otherwise drop the oldest messages, so the summary would describe only the
 * end of the conversation. Tool outputs shrink to one cap instead: a tool can
 * be run again, a message can't be recovered.
 */
async function fitRequest(
  model: ILLM,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<{ messages: ChatMessage[]; shortened: number }> {
  const request = [...messages, COMPACTION_PROMPT];
  if (fits(model, request)) {
    return { messages: request, shortened: 0 };
  }
  // Each check tokenizes the whole conversation, so let the extension host
  // run between checks, and stop when the compaction is cancelled
  const fitsWithCap = async (cap: number) => {
    await new Promise((resolve) => setImmediate(resolve));
    signal.throwIfAborted();
    return fits(model, withCap(request, cap).messages);
  };
  if (!(await fitsWithCap(MIN_OUTPUT_CHARS))) {
    throw new Error(TOO_LONG_TO_SUMMARIZE);
  }
  // `low` fits and `high` doesn't. Splitting at the geometric middle reaches
  // a cap within 25% of the largest that fits in a few checks
  let low = MIN_OUTPUT_CHARS;
  let high = Math.max(
    ...request.map((m) => (m.role === "tool" ? m.content.length : 0)),
  );
  while (high > low * 1.25) {
    const middle = Math.round(Math.sqrt(low * high));
    if (await fitsWithCap(middle)) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return withCap(request, low);
}

/**
 * Summarizes a conversation, so the GUI can store the summary on the message
 * it was asked for. Nothing is saved here: the GUI applies the result.
 *
 * @throws When the conversation doesn't fit the model's window even with
 * tool outputs shortened, so it is never summarized from its end only
 */
export async function compactConversation({
  messages,
  currentModel,
  signal,
}: CompactionParams): Promise<CompactionResult> {
  const fitted = await fitRequest(currentModel, messages, signal);
  const response = await currentModel.chat(fitted.messages, signal, {});
  const summary = stripImages(response.content);
  if (!summary.trim()) {
    throw new Error("The model returned an empty summary");
  }
  return { summary, shortenedOutputs: fitted.shortened };
}

// Compactions in progress, by session and message, so the GUI can cancel one
const inFlight = new Map<string, AbortController>();

/** The key of a compaction: one per message of a session */
export function compactionKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`;
}

/**
 * Starts tracking a compaction and returns its controller. A compaction
 * already running for the same message is cancelled: the newer request wins.
 */
export function startCompaction(key: string): AbortController {
  inFlight.get(key)?.abort();
  const controller = new AbortController();
  inFlight.set(key, controller);
  return controller;
}

/** Stops tracking a compaction, unless a newer one took its key */
export function finishCompaction(key: string, controller: AbortController) {
  if (inFlight.get(key) === controller) {
    inFlight.delete(key);
  }
}

/** Cancels the compaction running for this key and stops tracking it */
export function abortCompaction(key: string): void {
  inFlight.get(key)?.abort();
  inFlight.delete(key);
}
