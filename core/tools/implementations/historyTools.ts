import * as path from "node:path";

import { redactSecretText } from "@continuedev/terminal-security";
import type { HistoryStore } from "@nextcli/context/history-store";

import { ContextItem, ToolExtras } from "../..";
import {
  getIndexFolderPath,
  getSessionJournalPath,
  getSessionsFolderPath,
} from "../../util/paths";
import { ToolImpl } from ".";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

let storePromise: Promise<HistoryStore> | undefined;

/** One store per process, opened on first use, on the file cn uses too */
function getHistoryStore(): Promise<HistoryStore> {
  if (!storePromise) {
    storePromise = import("@nextcli/context/history-store")
      .then(({ HistoryStore }) =>
        HistoryStore.open({
          dbPath: path.join(getIndexFolderPath(), "history.sqlite"),
          sessionsDir: getSessionsFolderPath(),
          redact: redactSecretText,
        }),
      )
      .catch((e) => {
        storePromise = undefined;
        throw e;
      });
  }
  return storePromise;
}

function item(name: string, description: string, content: string) {
  return { name, description, content } satisfies ContextItem;
}

function errorItem(name: string, message: string): ContextItem[] {
  return [item(name, "Error", `Error: ${message}`)];
}

function describeState(state: string): string {
  return state === "folded" ? "compacted" : state === "cut" ? "undone" : "";
}

export const searchHistoryImpl: ToolImpl = async (args, extras) => {
  const name = "Search History";
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) {
    return errorItem(name, "query is required");
  }
  const scope = args?.scope ?? "session";
  if (scope !== "session" && scope !== "workspace" && scope !== "all") {
    return errorItem(name, `scope must be session, workspace or all`);
  }
  const requested = Number(args?.limit);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  let sessionIds: string[] | undefined;
  let workspace: string[] | undefined;
  if (scope === "session") {
    if (!extras.sessionId) {
      return errorItem(
        name,
        "the current session is unknown, so scope session can't be searched. Try scope workspace",
      );
    }
    sessionIds = [extras.sessionId];
  } else if (scope === "workspace") {
    // The index matches a folder however it was written: VS Code's file://
    // URI, cn's path, a symlink. Another host's folder (a remote URI) stays
    // apart even when its path reads the same
    workspace = await extras.ide.getWorkspaceDirs();
    if (!workspace.length) {
      return errorItem(
        name,
        "no folder is open, so scope workspace can't be searched. Try scope session",
      );
    }
  }

  const store = await getHistoryStore();
  const result = await store.search({
    text: query,
    sessionIds,
    workspace,
    limit,
  });

  const lines = result.hits.map((hit) => {
    const where =
      hit.sessionId === extras.sessionId
        ? "this session"
        : `session ${hit.sessionId} (${new Date(hit.ts).toISOString().slice(0, 10)})`;
    const state = describeState(hit.state);
    const what = [hit.role, hit.tool].filter(Boolean).join(" ");
    const partial = hit.missing
      ? `, partial, missing: ${hit.missing.join(", ")}`
      : "";
    return `${where} #${hit.ord} (${what}${state ? `, ${state}` : ""}${partial}): ${hit.snippet}`;
  });
  const notes: string[] = [];
  if (result.hits.some((hit) => hit.missing)) {
    notes.push(
      "Note: partial matches lack some of the words, so they may be about something else.",
    );
  }
  if (!lines.length) {
    notes.push(`No matches for "${query}" in scope ${scope}.`);
  }
  if (result.basic) {
    notes.push(
      "Note: full-text search isn't available on this Node version, so words are found by plain text comparison. Results are ranked the same way: items with every word first.",
    );
  }
  if (result.pending > 0) {
    notes.push(
      `Note: ${result.pending} conversation(s) are not indexed yet, so results may be incomplete. Search again in a moment.`,
    );
  }
  if (lines.length) {
    notes.push("Read an item in full with read_history.");
  }
  return [
    item(
      name,
      `Search results for "${query}"`,
      [...lines, ...notes].join("\n"),
    ),
  ];
};

const isMissing = (value: unknown) =>
  value === undefined || value === null || value === "";

/** A position such as 12, or undefined when the value isn't one */
function toPosition(value: unknown): number | undefined {
  const n = Number(value);
  return !isMissing(value) && Number.isInteger(n) && n >= 0 ? n : undefined;
}

export const readHistoryImpl: ToolImpl = async (args, extras) => {
  const name = "Read History";
  // Before anything else: the outline path must not skip this check
  const sessionId =
    typeof args?.session === "string" && args.session.trim()
      ? args.session.trim()
      : extras.sessionId;
  if (!sessionId) {
    return errorItem(
      name,
      "the current session is unknown. Pass the session id from a search_history result",
    );
  }
  if (!getSessionJournalPath(sessionId)) {
    return errorItem(name, `"${sessionId}" is not a session id`);
  }
  if (args?.outline === true || args?.outline === "true") {
    const start = isMissing(args?.from) ? 0 : toPosition(args?.from);
    if (start === undefined) {
      return errorItem(name, "from must be a position such as 12");
    }
    return outlineOf(name, sessionId, start);
  }
  const from = toPosition(args?.from);
  const to = isMissing(args?.to) ? from : toPosition(args?.to);
  if (from === undefined || to === undefined) {
    return errorItem(
      name,
      "from and to must be positions such as 12; to list the conversation's turns, pass outline: true",
    );
  }
  if (to < from) {
    return errorItem(name, "to must not be before from");
  }

  const store = await getHistoryStore();
  const { items, pending, next } = await store.read(sessionId, from, to);
  // An empty or short read isn't the end of the conversation when it wasn't
  // indexed to its end, or the size limit stopped it
  let note: string | undefined;
  if (pending) {
    note = NOT_INDEXED;
  } else if (next !== undefined) {
    note = `Note: stopped at the size limit; read from #${next} for the rest.`;
  }
  if (!items.length) {
    return note
      ? [item(name, "Not indexed yet", note)]
      : errorItem(name, `no items at #${from} to #${to} in that session`);
  }
  const blocks = items.map((i) => {
    const state = describeState(i.state);
    return `#${i.ord}${state ? ` (${state})` : ""} ${i.text}`;
  });
  return [
    item(
      name,
      `Items #${items[0].ord} to #${items[items.length - 1].ord}`,
      [...blocks, ...(note ? [note] : [])].join("\n\n"),
    ),
  ];
};

const NOT_INDEXED =
  "Note: this conversation isn't fully indexed yet (busy, or it changed), so items may be missing. Read again in a moment.";

/** One line per user message or compaction summary, from `from` */
async function outlineOf(
  name: string,
  sessionId: string,
  from: number,
): Promise<ContextItem[]> {
  const store = await getHistoryStore();
  const { items, pending, next } = await store.outline(sessionId, from);
  const lines = items.map((i) => {
    const state = describeState(i.state);
    return `#${i.ord}${state ? ` (${state})` : ""} ${i.kind}: ${i.text}`;
  });
  if (pending) {
    lines.push(NOT_INDEXED);
  } else if (next !== undefined) {
    lines.push(`Note: read the outline from #${next} for the rest.`);
  }
  return [
    item(
      name,
      "Outline",
      lines.length
        ? lines.join("\n")
        : "No user messages in that conversation.",
    ),
  ];
}
