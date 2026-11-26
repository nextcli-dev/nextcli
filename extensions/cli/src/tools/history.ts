import * as path from "path";

import { redactSecretText } from "@continuedev/terminal-security";
import {
  HistoryStore,
  type HistoryOutline,
} from "@nextcli/context/history-store";

import { getCurrentSession, getSessionDir } from "../session.js";

import { formatToolArgument } from "./formatters.js";
import { Tool } from "./types.js";

let store: Promise<HistoryStore> | undefined;

/**
 * The full-text index over the session transcripts, next to the sessions
 * folder (index/history.sqlite, or history-basic.sqlite where node:sqlite
 * has no FTS5), shared with the VS Code extension. Opened on first use, and
 * kept once it opens: an open that fails (another process holds the index
 * longer than the busy timeout) is tried again on the next call.
 */
function historyStore(): Promise<HistoryStore> {
  const sessionsDir = getSessionDir();
  store ??= HistoryStore.open({
    dbPath: path.join(path.dirname(sessionsDir), "index", "history.sqlite"),
    sessionsDir,
    redact: redactSecretText,
  }).catch((e: unknown) => {
    store = undefined;
    throw e;
  });
  return store;
}

const SCOPES = ["session", "workspace", "all"] as const;
type Scope = (typeof SCOPES)[number];

const MAX_RESULTS = 20;

export const searchHistoryTool: Tool = {
  name: "SearchHistory",
  displayName: "Search history",
  description:
    "Search the full transcript of this conversation, including turns that were compacted out of your context, or of earlier sessions. Use it to recover a requirement, a file path, an error or a decision from before a compaction. Items with every word come first, then items with some of them, marked with the words they lack. Words match whole, in any case, with common endings ('fix' finds 'fixed' and 'fixes', not 'prefix'), and inside identifiers ('config' finds 'loadConfig', 'id' finds 'getElementById'); common words such as 'the' or 'how' are skipped, and phrases aren't supported. Results give each item's session and position; read them with ReadHistory.",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "Words to find, such as a file path, an error or a name",
      },
      scope: {
        type: "string",
        description:
          "session (default): this conversation. workspace: sessions in this folder. all: every session; asks the user first",
      },
      limit: {
        type: "number",
        description: `At most ${MAX_RESULTS} results; 10 by default`,
      },
    },
  },
  readonly: true,
  isBuiltIn: true,
  // Other projects' transcripts would go to this model's provider
  requiresHumanApproval: (args) => args.scope === "all",
  preprocess: async (args) => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      throw new Error("query must be a non-empty string");
    }
    const scope: Scope = SCOPES.includes(args.scope) ? args.scope : "session";
    const where = {
      session: "this session",
      workspace: "sessions in this folder",
      all: "every session",
    }[scope];
    return {
      args: { ...args, query, scope },
      preview: [
        {
          type: "text",
          content: `Will search ${where} for ${formatToolArgument(query)}`,
        },
      ],
    };
  },
  run: async (args: {
    query: string;
    scope: Scope;
    limit?: number;
  }): Promise<string> => {
    const current = getCurrentSession().sessionId;
    const result = await (
      await historyStore()
    ).search({
      text: args.query,
      sessionIds: args.scope === "session" ? [current] : undefined,
      workspace: args.scope === "workspace" ? process.cwd() : undefined,
      limit: Math.min(Math.max(1, args.limit ?? 10), MAX_RESULTS),
    });
    const lines = result.hits.map((hit) => {
      const where = hit.sessionId === current ? "this session" : hit.sessionId;
      const what = hit.tool ? `${hit.role} ${hit.tool}` : hit.role;
      const state = { live: "", folded: ", compacted", cut: ", undone" }[
        hit.state
      ];
      const partial = hit.missing
        ? `, partial, missing: ${hit.missing.join(", ")}`
        : "";
      return `${where} #${hit.ord} (${what}${state}${partial}): ${hit.snippet.replace(/\s+/g, " ")}`;
    });
    const notes = [
      ...(result.hits.some((hit) => hit.missing)
        ? [
            "Partial matches lack some of the words, so they may be about something else.",
          ]
        : []),
      ...(result.basic
        ? [
            "Basic search: this Node.js has no FTS5, so the search is slower and results aren't ranked by relevance. Words match the same way, and items with every word still come first.",
          ]
        : []),
      ...(result.pending
        ? [
            `${result.pending} session(s) were not indexed yet; search again to include them.`,
          ]
        : []),
    ];
    return [
      lines.length ? lines.join("\n") : `No match for "${args.query}".`,
      ...notes,
    ].join("\n");
  },
};

const MAX_READ = 40;

export const readHistoryTool: Tool = {
  name: "ReadHistory",
  displayName: "Read history",
  description: `Read items of a session transcript verbatim, by position, as SearchHistory reports them: from the first to the last position, at most ${MAX_READ} items and about 80,000 characters. When a limit stops it, the result says where to read on. With outline: true it lists the session's user messages and compaction summaries instead, with their positions and first words: use it to find the part of a long session to read. Secrets are redacted.`,
  parameters: {
    type: "object",
    properties: {
      session: {
        type: "string",
        description:
          "The session id from SearchHistory; this session by default",
      },
      from: {
        type: "number",
        description:
          "First position (#) to read; with outline, the position to list from (0 by default)",
      },
      to: {
        type: "number",
        description: "Last position (#) to read; not used with outline",
      },
      outline: {
        type: "boolean",
        description:
          "List the session's user messages and compaction summaries instead of reading items",
      },
    },
  },
  readonly: true,
  isBuiltIn: true,
  // Another session can be another project's
  requiresHumanApproval: (args) =>
    typeof args.session === "string" &&
    args.session !== getCurrentSession().sessionId,
  preprocess: async (args) => {
    const session =
      typeof args.session === "string" && args.session
        ? args.session
        : getCurrentSession().sessionId;
    const where =
      session === getCurrentSession().sessionId ? "this session" : session;
    if (args.outline === true || args.outline === "true") {
      const from = args.from === undefined ? 0 : Number(args.from);
      if (!Number.isInteger(from) || from < 0) {
        throw new Error("from must be a position such as 12");
      }
      return {
        args: { session, from, outline: true },
        preview: [
          {
            type: "text",
            content: `Will read the outline of ${where}${from ? ` from #${from}` : ""}`,
          },
        ],
      };
    }
    const from = Number(args.from);
    // As read_history does: one item when "to" is left out
    const to =
      args.to === undefined || args.to === null ? from : Number(args.to);
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < from
    ) {
      throw new Error(
        "from and to must be positions with from <= to; to list the session's turns, pass outline: true",
      );
    }
    return {
      args: { session, from, to },
      preview: [
        {
          type: "text",
          content: `Will read #${from}-#${to} of ${where}`,
        },
      ],
    };
  },
  run: async (args: {
    session: string;
    from: number;
    to?: number;
    outline?: boolean;
  }): Promise<string> => {
    const store = await historyStore();
    if (args.outline) {
      return outlineText(await store.outline(args.session, args.from));
    }
    const to = args.to ?? args.from;
    const { items, pending, next } = await store.read(
      args.session,
      args.from,
      to,
    );
    // An empty or short read isn't the end of the transcript when it wasn't
    // indexed to its end, or the size limit stopped it
    let note: string | undefined;
    if (pending) {
      note = NOT_INDEXED;
    } else if (next !== undefined) {
      note = `Stopped at the size limit; read from #${next} for the rest.`;
    }
    if (!items.length) {
      return note ?? `Nothing at #${args.from}-#${to} of that session.`;
    }
    return [
      ...items.map((item) => {
        const state = { live: "", folded: " (compacted)", cut: " (undone)" }[
          item.state
        ];
        return `#${item.ord}${state} ${item.text}`;
      }),
      ...(note ? [note] : []),
    ].join("\n\n");
  },
};

const NOT_INDEXED =
  "This session isn't fully indexed yet (busy, or it changed); read again for the rest.";

/** One line per user message or compaction summary */
function outlineText({ items, pending, next }: HistoryOutline): string {
  const lines = items.map((item) => {
    const state = item.state === "folded" ? " (compacted)" : "";
    return `#${item.ord}${state} ${item.kind}: ${item.text}`;
  });
  if (pending) {
    lines.push(NOT_INDEXED);
  } else if (next !== undefined) {
    lines.push(`More: read the outline from #${next}.`);
  }
  return lines.length ? lines.join("\n") : "No user messages in that session.";
}
