import { IDE, Position, Range, RangeInFileWithNextEditInfo } from "core";
import { AutocompleteCodeSnippet } from "core/autocomplete/snippets/types";
import { GetLspDefinitionsFunction } from "core/autocomplete/types";
import { ConfigHandler } from "core/config/ConfigHandler";
import { EditAggregator } from "core/nextEdit/context/aggregateEdits";
import { RecentlyEditedRange } from "core/nextEdit/types";
import * as vscode from "vscode";

import type { ContinueCompletionProvider } from "../autocomplete/completionProvider";
import type { Core } from "core/core";

// Cache to store the last known content for each file (before edits)
const documentContentCache = new Map<string, string>();

/**
 * Gets the cached content for a document, or reads the current content if not cached.
 * This should be called BEFORE processing the edit to get the pre-edit state.
 */
export const getPreEditContent = (document: vscode.TextDocument): string => {
  const uri = document.uri.toString();
  const cached = documentContentCache.get(uri);
  if (cached !== undefined) {
    return cached;
  }
  // If not cached, this is the first edit we're seeing - the document's current state
  // in the event is already post-edit, so we can't get the true pre-edit content.
  // Return empty string to indicate no prior content was tracked.
  return "";
};

/**
 * Updates the cache with the current document content.
 * This should be called AFTER processing the edit.
 */
export const updateDocumentContentCache = (
  document: vscode.TextDocument,
): void => {
  documentContentCache.set(document.uri.toString(), document.getText());
};

/**
 * Initializes the cache for a document when it's opened.
 */
export const initDocumentContentCache = (
  document: vscode.TextDocument,
): void => {
  documentContentCache.set(document.uri.toString(), document.getText());
};

/**
 * Removes a document from the cache when it's closed.
 */
export const clearDocumentContentCache = (uri: string): void => {
  documentContentCache.delete(uri);
};

/**
 * Starts edit tracking when Next Edit turns on: the open documents become the
 * pre-edit content. Also drops edit clusters left in core, such as one from an
 * edit that reached core as Next Edit turned off.
 */
export const startEditTracking = (
  documents: readonly vscode.TextDocument[],
): void => {
  EditAggregator.getInstance().resetState();
  for (const document of documents) {
    initDocumentContentCache(document);
  }
};

/**
 * Stops edit tracking when Next Edit turns off. Drops the pre-edit content and
 * the open edit clusters: a cluster kept open would absorb the typing done
 * while Next Edit is off into the next session's first diff.
 */
export const stopEditTracking = (): void => {
  documentContentCache.clear();
  EditAggregator.getInstance().resetState();
};

export const getBeforeCursorPos = (range: Range, activePos: Position) => {
  // whichever side of the range isn't active is the before position
  if (
    range.start.line === activePos.line &&
    range.start.character === activePos.character
  ) {
    return range.end as Position;
  } else {
    return range.start as Position;
  }
};

const getWorkspaceDirUri = (event: vscode.TextDocumentChangeEvent) => {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(
    event.document.uri,
  );
  if (!workspaceFolder) {
    return false;
  }

  const workspaceDirUri = workspaceFolder.uri.toString();
  return workspaceDirUri;
};

export const handleTextDocumentChange = async (
  event: vscode.TextDocumentChangeEvent,
  configHandler: ConfigHandler,
  ide: IDE,
  completionProvider: ContinueCompletionProvider,
  getDefinitionsFromLsp: GetLspDefinitionsFunction,
) => {
  const changes = event.contentChanges;
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return;
  }
  if (event.contentChanges.length === 0) {
    return;
  }

  // Ensure that logging will only happen in the open-source continue repo
  const workspaceDirUri = getWorkspaceDirUri(event);
  if (!workspaceDirUri) {
    return;
  }

  // Get the pre-edit content from our cache BEFORE updating it
  const fileContentsBefore = getPreEditContent(event.document);

  const activeCursorPos = editor.selection.active;
  const editActions: RangeInFileWithNextEditInfo[] = changes.map((change) => ({
    filepath: event.document.uri.toString(),
    range: {
      start: change.range.start as Position,
      end: change.range.end as Position,
    },
    fileContents: event.document.getText(),
    fileContentsBefore,
    editText: change.text,
    beforeCursorPos: getBeforeCursorPos(change.range, activeCursorPos),
    afterCursorPos: activeCursorPos as Position,
    workspaceDir: workspaceDirUri,
  }));

  // Update the cache with the new content AFTER capturing the edit
  updateDocumentContentCache(event.document);

  let recentlyEditedRanges: RecentlyEditedRange[] = [];
  let recentlyVisitedRanges: AutocompleteCodeSnippet[] = [];

  if (completionProvider) {
    recentlyEditedRanges =
      await completionProvider.recentlyEditedTracker.getRecentlyEditedRanges();
    recentlyVisitedRanges =
      completionProvider.recentlyVisitedRanges.getSnippets();
  }

  return {
    actions: editActions,
    configHandler: configHandler,
    getDefsFromLspFunction: getDefinitionsFromLsp,
    recentlyEditedRanges,
    recentlyVisitedRanges,
  };
};

/**
 * Sends a document edit to core (files/smallEdit), only while Next Edit is
 * active: nothing else reads the edit history or the autocomplete context it
 * feeds. While it is inactive no document text is copied.
 */
export const trackDocumentEdit = async (
  event: vscode.TextDocumentChangeEvent,
  configHandler: ConfigHandler,
  ide: IDE,
  completionProvider: ContinueCompletionProvider,
  getDefinitionsFromLsp: GetLspDefinitionsFunction,
  core: Core,
): Promise<void> => {
  // handleTextDocumentChange reads and updates the pre-edit cache before its
  // first await, so turning Next Edit off can't land between this check and
  // the cache update
  if (!completionProvider.nextEditActive) {
    return;
  }
  const editInfo = await handleTextDocumentChange(
    event,
    configHandler,
    ide,
    completionProvider,
    getDefinitionsFromLsp,
  );
  // Next Edit may have turned off while the recent ranges loaded
  if (editInfo && completionProvider.nextEditActive) {
    core.invoke("files/smallEdit", editInfo);
  }
};
