import type { ChatHistoryItem } from "core/index.js";

import { truncateByLinesAndChars } from "./util/truncateOutput.js";

/** Room every fit check keeps below the window for errors in the token estimate */
export const REQUEST_SAFETY_BUFFER = 100;

/** Starts the note that stands in for messages left out of a request */
export const PRUNED_HISTORY_NOTE_PREFIX = "[Context note:";

// A tool output over twice this length is cut to its start when the history
// doesn't fit. Outputs can be fetched again by running the tool; messages
// can't, so outputs shrink before any message is left out.
const SHORTENED_OUTPUT_MAX_CHARS = 2_000;
const SHORTENED_OUTPUT_MAX_LINES = 50;

export interface FittedHistory {
  history: ChatHistoryItem[];
  /** Messages left out: older turns, then older steps of the newest turn */
  removed: number;
  /** Tool outputs cut down to their start */
  shortened: number;
  fits: boolean;
}

/** Where a tool output long enough to shorten sits in a history */
interface OutputRef {
  item: number;
  /** Index in the item's toolCallStates and in that state's output; none for a tool message */
  state?: number;
  part?: number;
}

const isLong = (text: unknown): text is string =>
  typeof text === "string" && text.length > 2 * SHORTENED_OUTPUT_MAX_CHARS;

function longOutputs(history: ChatHistoryItem[]): OutputRef[] {
  const refs: OutputRef[] = [];
  history.forEach((item, i) => {
    if (item.message.role === "tool" && isLong(item.message.content)) {
      refs.push({ item: i });
    }
    item.toolCallStates?.forEach((state, s) =>
      state.output?.forEach((output, p) => {
        if (isLong(output.content)) {
          refs.push({ item: i, state: s, part: p });
        }
      }),
    );
  });
  return refs;
}

function shorten(text: string): string {
  return truncateByLinesAndChars(
    text,
    SHORTENED_OUTPUT_MAX_LINES,
    SHORTENED_OUTPUT_MAX_CHARS,
    "tool output",
  ).output;
}

/** A copy of the history with these outputs shortened; the input is left as it is */
function withShortened(
  history: ChatHistoryItem[],
  refs: OutputRef[],
): ChatHistoryItem[] {
  const copy = [...history];
  for (const ref of refs) {
    const item = copy[ref.item];
    if (ref.state === undefined || ref.part === undefined) {
      copy[ref.item] = {
        ...item,
        message: {
          ...item.message,
          content: shorten(item.message.content as string),
        },
      } as ChatHistoryItem;
      continue;
    }
    const states = [...item.toolCallStates!];
    const output = [...states[ref.state].output!];
    output[ref.part] = {
      ...output[ref.part],
      content: shorten(output[ref.part].content),
    };
    states[ref.state] = { ...states[ref.state], output };
    copy[ref.item] = { ...item, toolCallStates: states };
  }
  return copy;
}

/**
 * The history with a note in front saying how many messages are gone. The
 * note joins a leading user message, so roles still alternate for providers
 * that require it.
 */
function withPrunedNote(
  history: ChatHistoryItem[],
  removed: number,
): ChatHistoryItem[] {
  const note = `${PRUNED_HISTORY_NOTE_PREFIX} ${removed} earlier messages of this conversation were left out to fit the context window. Continue from the messages below.]`;
  const [first, ...rest] = history;
  if (first?.message.role !== "user") {
    return [
      { message: { role: "user", content: note }, contextItems: [] },
      ...history,
    ];
  }
  const content = first.message.content;
  return [
    {
      ...first,
      message: {
        ...first.message,
        content:
          typeof content === "string"
            ? `${note}\n\n${content}`
            : [{ type: "text", text: note }, ...content],
      },
    },
    ...rest,
  ];
}

/** Where the last step starts: the last item that isn't a tool result */
function lastStepStart(history: ChatHistoryItem[]): number {
  let i = history.length - 1;
  while (i > 0 && history[i].message.role === "tool") {
    i--;
  }
  return i;
}

/**
 * The history without its oldest part: the oldest whole turn (a user message
 * and everything up to the next one) while an older turn than the newest one
 * exists, then the oldest step of the newest turn (an assistant message and
 * its tool results). Never the newest user message or the last step; null
 * when nothing else is left.
 */
function dropOldestPart(history: ChatHistoryItem[]): ChatHistoryItem[] | null {
  if (history.length === 0) {
    return null;
  }
  const isUser = (item: ChatHistoryItem) => item.message.role === "user";
  const nextUser = history.findIndex((item, i) => i > 0 && isUser(item));
  if (nextUser > 0) {
    return history.slice(nextUser);
  }
  // Only the newest turn is left: keep its user message, drop its oldest step
  const stepStart = isUser(history[0]) ? 1 : 0;
  let stepEnd = stepStart + 1;
  while (stepEnd < history.length && history[stepEnd].message.role === "tool") {
    stepEnd++;
  }
  if (stepEnd >= history.length) {
    return null;
  }
  return [...history.slice(0, stepStart), ...history.slice(stepEnd)];
}

/** The smallest n in 1..max for which fits(n) holds, or null; fits grows with n */
function smallestFitting(
  max: number,
  fits: (n: number) => boolean,
): number | null {
  if (max < 1 || !fits(max)) {
    return null;
  }
  let low = 1;
  let high = max;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

/**
 * Makes a history fit, giving up as little as it can, in this order:
 * 1. shorten tool outputs before the last step, oldest first;
 * 2. leave out older turns, then older steps of the newest turn, with a note
 *    in front saying how many messages are gone;
 * 3. shorten the last step's outputs.
 * A leading summary from an earlier compaction, the newest user message and
 * the last step are never left out, and a tool call keeps its results.
 * Returns the history as given when it fits, else the smallest one it can
 * make, with `fits: false` when even that doesn't fit.
 * @param chatHistory The history to send
 * @param fits Whether a history fits the request
 */
export function fitHistory(
  chatHistory: ChatHistoryItem[],
  fits: (history: ChatHistoryItem[]) => boolean,
): FittedHistory {
  if (fits(chatHistory)) {
    return { history: chatHistory, removed: 0, shortened: 0, fits: true };
  }
  // The summary is the only record of the conversation before it
  const summary =
    chatHistory[0]?.conversationSummary === undefined
      ? []
      : chatHistory.slice(0, 1);
  const body = chatHistory.slice(summary.length);
  const outputs = longOutputs(body);
  const lastStep = lastStepStart(body);
  const older = outputs.filter((ref) => ref.item < lastStep);
  const newest = outputs.filter((ref) => ref.item >= lastStep);

  // 1. Older tool outputs
  const olderShortened = (n: number) => [
    ...summary,
    ...withShortened(body, older.slice(0, n)),
  ];
  const shortenedOlder = smallestFitting(older.length, (n) =>
    fits(olderShortened(n)),
  );
  if (shortenedOlder !== null) {
    return {
      history: olderShortened(shortenedOlder),
      removed: 0,
      shortened: shortenedOlder,
      fits: true,
    };
  }

  // 2. Older messages
  const shortenedBody = withShortened(body, older);
  const drops: ChatHistoryItem[][] = [];
  for (
    let next = dropOldestPart(shortenedBody);
    next;
    next = dropOldestPart(next)
  ) {
    drops.push(next);
  }
  const afterDrops = (n: number) => [
    ...summary,
    ...withPrunedNote(drops[n - 1], body.length - drops[n - 1].length),
  ];
  const dropped = smallestFitting(drops.length, (n) => fits(afterDrops(n)));
  if (dropped !== null) {
    return {
      history: afterDrops(dropped),
      removed: body.length - drops[dropped - 1].length,
      shortened: older.length,
      fits: true,
    };
  }

  // 3. The last step's outputs. The last step is never dropped, so it keeps
  // its distance from the end.
  const kept = drops.at(-1) ?? shortenedBody;
  const removed = body.length - kept.length;
  const newestInKept = newest.map((ref) => ({
    ...ref,
    item: kept.length - (body.length - ref.item),
  }));
  const newestShortened = (n: number) => {
    const history = withShortened(kept, newestInKept.slice(0, n));
    return [
      ...summary,
      ...(removed > 0 ? withPrunedNote(history, removed) : history),
    ];
  };
  const shortenedNewest = smallestFitting(newest.length, (n) =>
    fits(newestShortened(n)),
  );
  const n = shortenedNewest ?? newest.length;
  return {
    history: newestShortened(n),
    removed,
    shortened: older.length + n,
    fits: shortenedNewest !== null,
  };
}

/** "3 earlier messages were left out and 1 tool output was shortened" */
export function describeFit({
  removed,
  shortened,
}: Pick<FittedHistory, "removed" | "shortened">): string {
  const counted = (n: number, noun: string, done: string) =>
    `${n} ${noun}${n === 1 ? " was" : "s were"} ${done}`;
  return [
    removed > 0 && counted(removed, "earlier message", "left out"),
    shortened > 0 && counted(shortened, "tool output", "shortened"),
  ]
    .filter(Boolean)
    .join(" and ");
}
