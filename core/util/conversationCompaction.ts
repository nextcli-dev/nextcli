import { ChatMessage, ILLM } from "..";
import { stripImages } from "./messageContent";

export interface CompactionParams {
  /**
   * The conversation to summarize, built by the GUI the way it builds a turn
   * (constructMessages): system prompt, rules, context and tool results
   */
  messages: ChatMessage[];
  currentModel: ILLM;
  signal: AbortSignal;
}

/**
 * Summarizes a conversation, so the GUI can store the summary on the message
 * it was asked for. Nothing is saved here: the GUI applies the result to the
 * history it shows.
 *
 * @returns The summary, without images
 */
export async function compactConversation({
  messages,
  currentModel,
  signal,
}: CompactionParams): Promise<string> {
  const compactionPrompt = {
    role: "user" as const,
    content:
      "Create a comprehensive summary of this conversation that captures all essential information needed to continue the work seamlessly. Structure your response to preserve technical accuracy and context continuity.\n\nYour summary should include:\n\n1. **Conversation Overview**: Describe the main topic and progression of the discussion, including any shifts in focus or direction.\n\n2. **Active Development**: Detail what was being implemented, modified, or debugged most recently. Include specific technical approaches and methodologies used.\n\n3. **Technical Stack**: List all relevant technologies, frameworks, libraries, coding patterns, and architectural decisions discussed.\n\n4. **File Operations**: Document all files that were created, modified, or referenced, including their purposes and key changes. Include important code snippets and their locations.\n\n5. **Solutions & Troubleshooting**: Summarize problems encountered and how they were resolved, including any debugging steps or workarounds applied.\n\n6. **Outstanding Work**: Clearly identify any incomplete tasks, pending implementations, or next steps that were discussed. Include direct references to user requests and current progress.\n\nIf there's a previous summary in the conversation, integrate its relevant information while removing outdated details. Focus on technical precision and include specific identifiers (file paths, function names, class names, etc.) that would be essential for continuation. Write in third person and maintain an objective, technical tone.",
  };

  const response = await currentModel.chat(
    [...messages, compactionPrompt],
    signal,
    {},
  );
  const summary = stripImages(response.content);
  if (!summary.trim()) {
    throw new Error("The model returned an empty summary");
  }
  return summary;
}

// Compactions in progress, by session and message, so the GUI can cancel one
const inFlight = new Map<string, AbortController>();

/** The key of a compaction: one per message of a session */
export function compactionKey(sessionId: string, index: number): string {
  return `${sessionId}:${index}`;
}

/**
 * Starts tracking a compaction and returns its signal. A compaction already
 * running for the same message is cancelled: the newer request wins.
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

/** Cancels the compaction running for this key, if there is one */
export function abortCompaction(key: string): void {
  inFlight.get(key)?.abort();
}
