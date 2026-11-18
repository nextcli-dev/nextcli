import { createAsyncThunk } from "@reduxjs/toolkit";
import { ChatHistoryItem, ContextItemWithId } from "core";
import { CodeBlock } from "../../components/mainInput/TipTapEditor/extensions/CodeBlock/CodeBlock";
import { updateFileSymbols } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";

/** File context items attached to one history item */
function normalContextItems(item: ChatHistoryItem): ContextItemWithId[] {
  return (
    item.contextItems?.filter(
      (item) => item.uri?.type === "file" && item.uri?.value,
    ) ?? []
  );
}

/** File context items in one history item's code-block toolbars */
function toolbarContextItems(item: ChatHistoryItem): ContextItemWithId[] {
  if (!item.editorState || !Array.isArray(item.editorState.content)) {
    return [];
  }
  return item.editorState.content
    .filter(
      (content: any) =>
        content?.type === CodeBlock.name &&
        content?.attrs?.item?.uri?.value &&
        content.attrs.item.uri?.type === "file",
    )
    .map((content: any) => content.attrs!.item!);
}

export function getContextItemsFromHistory(
  historyItems: ChatHistoryItem[],
  priorToIndex?: number,
) {
  const pastHistoryItems = historyItems.filter(
    (_, i) => i <= (priorToIndex ?? historyItems.length - 1),
  );
  return [
    ...pastHistoryItems.flatMap(normalContextItems),
    ...pastHistoryItems.flatMap(toolbarContextItems),
  ];
}

interface PastContextItemsCache {
  history: readonly ChatHistoryItem[];
  /** Entry i: getContextItemsFromHistory(history, i) */
  entries: ContextItemWithId[][];
  normal: ContextItemWithId[][];
  toolbar: ContextItemWithId[][];
}

let pastContextItemsCache: PastContextItemsCache | undefined;
const NO_ITEMS: ContextItemWithId[] = [];

/**
 * For each history index, the file context items of the items up to it: the
 * same as getContextItemsFromHistory(history, i), shared by every caller and
 * computed once per history. Unchanged items keep their identity in the
 * store, so while a reply streams only the entries from the changed item on
 * are rebuilt, and every other entry keeps its array.
 */
export function selectPastContextItems(
  history: readonly ChatHistoryItem[],
): ContextItemWithId[][] {
  const previous = pastContextItemsCache;
  if (previous?.history === history) return previous.entries;

  const entries: ContextItemWithId[][] = [];
  const normal: ContextItemWithId[][] = [];
  const toolbar: ContextItemWithId[][] = [];
  let reusing = !!previous;
  for (let i = 0; i < history.length; i++) {
    if (
      reusing &&
      previous!.history[i] === history[i] &&
      i < previous!.entries.length
    ) {
      entries.push(previous!.entries[i]);
      normal.push(previous!.normal[i]);
      toolbar.push(previous!.toolbar[i]);
      continue;
    }
    reusing = false;
    const ownNormal = normalContextItems(history[i]);
    const ownToolbar = toolbarContextItems(history[i]);
    const prevNormal = normal[i - 1] ?? NO_ITEMS;
    const prevToolbar = toolbar[i - 1] ?? NO_ITEMS;
    normal.push(ownNormal.length ? [...prevNormal, ...ownNormal] : prevNormal);
    toolbar.push(
      ownToolbar.length ? [...prevToolbar, ...ownToolbar] : prevToolbar,
    );
    const prevEntry = entries[i - 1];
    entries.push(
      !ownNormal.length && !ownToolbar.length && prevEntry
        ? prevEntry
        : [...normal[i], ...toolbar[i]],
    );
  }
  pastContextItemsCache = { history, entries, normal, toolbar };
  return entries;
}

/*
    Get file symbols for given context items
    Overwrite symbols for existing file matches
*/
export const updateFileSymbolsFromFiles = createAsyncThunk<
  void,
  string[],
  ThunkApiType
>(
  "symbols/updateFromContextItems",
  async (filepaths, { dispatch, extra, getState }) => {
    try {
      // Get unique file uris from context items
      const uniqueUris = Array.from(new Set(filepaths));

      // Update symbols for those files
      if (uniqueUris.length > 0) {
        const result = await extra.ideMessenger.request(
          "context/getSymbolsForFiles",
          { uris: uniqueUris },
        );
        if (result.status === "error") {
          throw new Error(result.error);
        }
        dispatch(updateFileSymbols(result.content));
      }
    } catch (e) {
      console.error("Error updating file symbols from filepaths", e, filepaths);
    }
  },
);

/*
    - Update file symbols for all context items in history
    - That don't already have symbols
*/
export const updateFileSymbolsFromHistory = createAsyncThunk<
  void,
  undefined,
  ThunkApiType
>("symbols/updateFromHistory", async (_, { dispatch, extra, getState }) => {
  try {
    const state = getState();

    // Get unique context item file uris from all history
    const contextItems = getContextItemsFromHistory(state.session.history);

    const uniqueUris = new Set(
      contextItems
        .filter((item) => item?.uri?.type === "file" && item?.uri?.value)
        .map((item) => item.uri!.value),
    );

    // Remove if already in symbols
    Object.keys(state.session.symbols).forEach((key) => {
      uniqueUris.delete(key);
    });

    const uriArray = Array.from(uniqueUris);

    // And then update symbols for those files
    if (uriArray.length > 0) {
      const result = await extra.ideMessenger.request(
        "context/getSymbolsForFiles",
        { uris: uriArray },
      );
      if (result.status === "error") {
        throw new Error(result.error);
      }
      dispatch(updateFileSymbols(result.content));
    }
  } catch (e) {
    // Catch all - don't want file symbols to break the chat experience for now
    console.error("Error updating file symbols from context items", e);
  }
});
