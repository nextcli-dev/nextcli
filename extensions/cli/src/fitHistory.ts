import type { ChatHistoryItem } from "core/index.js";

import { truncateByLinesAndChars } from "./util/truncateOutput.js";

/** Room every fit check keeps below the window for errors in the token estimate */
export const REQUEST_SAFETY_BUFFER = 100;

/** Starts the note that stands in for messages left out of a request */
export const PRUNED_HISTORY_NOTE_PREFIX = "[Context note:";

// When a history doesn't fit, tool outputs are cut to their start, all to one
// cap: the largest that fits, never below this floor. A tool can be run
// again; a message can't be fetched again, so outputs shrink before any
// message is left out.
const MIN_OUTPUT_CHARS = 500;
// An output is cut only when that saves more than the truncation note adds
const TRUNCATION_NOTE_ROOM = 100;

export interface FittedHistory {
  history: ChatHistoryItem[];
  /** Messages left out: older turns, then older steps of the newest turn */
  removed: number;
  /** Tool outputs cut down to their start */
  shortened: number;
  fits: boolean;
}

/** Where a tool output sits in a history, and its length */
interface OutputRef {
  item: number;
  /** Index in the item's toolCallStates and in that state's output; none for a tool message */
  state?: number;
  part?: number;
  length: number;
}

/** The tool outputs of the items from `from` up to `to` */
function toolOutputs(
  history: ChatHistoryItem[],
  from: number,
  to: number,
): OutputRef[] {
  const refs: OutputRef[] = [];
  for (let i = from; i < to; i++) {
    const item = history[i];
    if (
      item.message.role === "tool" &&
      typeof item.message.content === "string"
    ) {
      refs.push({ item: i, length: item.message.content.length });
    }
    item.toolCallStates?.forEach((state, s) =>
      state.output?.forEach((output, p) => {
        if (typeof output.content === "string") {
          refs.push({
            item: i,
            state: s,
            part: p,
            length: output.content.length,
          });
        }
      }),
    );
  }
  return refs;
}

const longest = (refs: OutputRef[]) =>
  refs.reduce((max, ref) => Math.max(max, ref.length), 0);

/** The start of a text, by characters only, so a lower cap always means less */
function cut(text: string, cap: number): string {
  return truncateByLinesAndChars(
    text,
    Number.MAX_SAFE_INTEGER,
    cap,
    "tool output",
  ).output;
}

/**
 * A copy of the history with each listed output longer than the cap cut to
 * it; the input is left as it is. The outputs it cuts go into `cutOutputs`,
 * so the result can count the ones still in the history it returns.
 */
function withCap(
  history: ChatHistoryItem[],
  refs: OutputRef[],
  cap: number,
  cutOutputs: WeakSet<object>,
): ChatHistoryItem[] {
  const copy = [...history];
  for (const ref of refs) {
    if (ref.length <= cap + TRUNCATION_NOTE_ROOM) {
      continue;
    }
    const item = copy[ref.item];
    if (ref.state === undefined || ref.part === undefined) {
      const shortened = {
        ...item,
        message: {
          ...item.message,
          content: cut(item.message.content as string, cap),
        },
      } as ChatHistoryItem;
      cutOutputs.add(shortened);
      copy[ref.item] = shortened;
      continue;
    }
    const states = [...item.toolCallStates!];
    const output = [...states[ref.state].output!];
    output[ref.part] = {
      ...output[ref.part],
      content: cut(output[ref.part].content, cap),
    };
    cutOutputs.add(output[ref.part]);
    states[ref.state] = { ...states[ref.state], output };
    copy[ref.item] = { ...item, toolCallStates: states };
  }
  return copy;
}

/** How many cut outputs a history still holds */
function countCut(
  history: ChatHistoryItem[],
  cutOutputs: WeakSet<object>,
): number {
  let count = 0;
  for (const item of history) {
    if (cutOutputs.has(item)) {
      count++;
    }
    for (const state of item.toolCallStates ?? []) {
      count += (state.output ?? []).filter((output) =>
        cutOutputs.has(output),
      ).length;
    }
  }
  return count;
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
  if (history.length === 0) {
    return 0;
  }
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

/** The largest cap in min..max for which fits(cap) holds, or null; fits shrinks as the cap grows */
function largestFitting(
  min: number,
  max: number,
  fits: (cap: number) => boolean,
): number | null {
  if (max < min || !fits(min)) {
    return null;
  }
  let low = min;
  let high = max;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/**
 * Makes a history fit, giving up as little as it can, in this order:
 * 1. cut the tool outputs before the last step to one cap, the largest that
 *    fits: the longest outputs shrink first, short ones stay whole;
 * 2. with those outputs at the floor, leave out older turns, then older steps
 *    of the newest turn, with a note in front saying how many messages are
 *    gone;
 * 3. cut the last step's tool outputs the same way.
 * A leading summary from an earlier compaction, the newest user message and
 * the last step are never left out, a tool call keeps its results, and text
 * other than tool output is never cut. Returns the history as given when it
 * fits, else the smallest one it can make, with `fits: false` when even that
 * doesn't fit. The counts describe the returned history.
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
  const cutOutputs = new WeakSet<object>();
  const result = (
    history: ChatHistoryItem[],
    removed: number,
    fitted: boolean,
  ): FittedHistory => ({
    history,
    removed,
    shortened: countCut(history, cutOutputs),
    fits: fitted,
  });

  // 1. The tool outputs before the last step
  const older = toolOutputs(body, 0, lastStepStart(body));
  const olderCapped = (cap: number) => [
    ...summary,
    ...withCap(body, older, cap, cutOutputs),
  ];
  const olderCap = largestFitting(MIN_OUTPUT_CHARS, longest(older), (cap) =>
    fits(olderCapped(cap)),
  );
  if (olderCap !== null) {
    return result(olderCapped(olderCap), 0, true);
  }

  // 2. Older messages
  const floorBody = withCap(body, older, MIN_OUTPUT_CHARS, cutOutputs);
  const drops: ChatHistoryItem[][] = [];
  for (
    let next = dropOldestPart(floorBody);
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
    return result(
      afterDrops(dropped),
      body.length - drops[dropped - 1].length,
      true,
    );
  }

  // 3. The last step's tool outputs, which is never left out
  const kept = drops.at(-1) ?? floorBody;
  const removed = body.length - kept.length;
  const newest = toolOutputs(kept, lastStepStart(kept), kept.length);
  const newestCapped = (cap: number) => {
    const history = withCap(kept, newest, cap, cutOutputs);
    return [
      ...summary,
      ...(removed > 0 ? withPrunedNote(history, removed) : history),
    ];
  };
  const newestCap = largestFitting(MIN_OUTPUT_CHARS, longest(newest), (cap) =>
    fits(newestCapped(cap)),
  );
  return result(
    newestCapped(newestCap ?? MIN_OUTPUT_CHARS),
    removed,
    newestCap !== null,
  );
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
