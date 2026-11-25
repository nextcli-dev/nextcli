import * as fs from "node:fs";
import * as path from "node:path";

import { redactSecretText } from "@continuedev/terminal-security";
import type { HistoryStore } from "@nextcli/context/history-store";

import { ContextItem, ToolExtras } from "../..";
import {
  getIndexFolderPath,
  getSessionJournalPath,
  getSessionsFolderPath,
} from "../../util/paths";
import { isSameLocalPath } from "../../util/uri";
import { ToolImpl } from ".";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
// Workspace scope looks at the newest transcripts only
const MAX_WORKSPACE_SESSIONS = 500;
const HEAD_BYTES = 8_192;

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

/** The workspace a transcript was started in: its head line */
function readHeadWorkspace(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
      const line = buffer.toString("utf8", 0, n).split("\n")[0];
      const head = JSON.parse(line) as { t?: string; workspace?: string };
      return head.t === "head" && head.workspace ? head.workspace : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * The sessions started in one of the workspace folders. The GUI saves a
 * folder as a URI and the IDE lists it as one too, but encoding and drive
 * letter case differ between sources, so compare them as paths.
 */
async function sessionsOfWorkspace(extras: ToolExtras): Promise<string[]> {
  const dirs = await extras.ide.getWorkspaceDirs();
  const sessionsDir = getSessionsFolderPath();
  const files = fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      id: f.slice(0, -".jsonl".length),
      mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  const ids: string[] = [];
  for (const { id } of files) {
    const workspace = readHeadWorkspace(path.join(sessionsDir, `${id}.jsonl`));
    if (workspace && dirs.some((dir) => isSameLocalPath(dir, workspace))) {
      ids.push(id);
      if (ids.length === MAX_WORKSPACE_SESSIONS) {
        break;
      }
    }
  }
  return ids;
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
  if (scope === "session") {
    if (!extras.sessionId) {
      return errorItem(
        name,
        "the current session is unknown, so scope session can't be searched. Try scope workspace",
      );
    }
    sessionIds = [extras.sessionId];
  } else if (scope === "workspace") {
    sessionIds = await sessionsOfWorkspace(extras);
    if (!sessionIds.length) {
      return [
        item(name, "No results", "No saved conversations in this workspace."),
      ];
    }
  }

  const store = await getHistoryStore();
  const result = await store.search({ text: query, sessionIds, limit });

  const lines = result.hits.map((hit) => {
    const where =
      hit.sessionId === extras.sessionId
        ? "this session"
        : `session ${hit.sessionId} (${new Date(hit.ts).toISOString().slice(0, 10)})`;
    const state = describeState(hit.state);
    const what = [hit.role, hit.tool].filter(Boolean).join(" ");
    return `${where} #${hit.ord} (${what}${state ? `, ${state}` : ""}): ${hit.snippet}`;
  });
  const notes: string[] = [];
  if (!lines.length) {
    notes.push(`No matches for "${query}" in scope ${scope}.`);
  }
  if (result.basic) {
    notes.push(
      "Note: full-text search isn't available on this Node version, so this is a plain substring match of every word, newest first.",
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

function toPosition(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

export const readHistoryImpl: ToolImpl = async (args, extras) => {
  const name = "Read History";
  const from = toPosition(args?.from);
  const to = toPosition(args?.to) ?? from;
  if (from === undefined || Number.isNaN(from) || Number.isNaN(to)) {
    return errorItem(name, "from and to must be positions such as 12");
  }
  if (to! < from) {
    return errorItem(name, "to must not be before from");
  }
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

  const store = await getHistoryStore();
  const items = await store.read(sessionId, from, to!);
  if (!items.length) {
    return errorItem(name, `no items at #${from} to #${to} in that session`);
  }
  const blocks = items.map((i) => {
    const state = describeState(i.state);
    return `#${i.ord}${state ? ` (${state})` : ""} ${i.text}`;
  });
  return [
    item(
      name,
      `Items #${items[0].ord} to #${items[items.length - 1].ord}`,
      blocks.join("\n\n"),
    ),
  ];
};
