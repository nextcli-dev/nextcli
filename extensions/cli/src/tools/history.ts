import * as path from "path";

import { redactSecretText } from "@continuedev/terminal-security";
import { HistoryStore } from "@nextcli/context/history-store";

import { getCurrentSession, getSessionDir } from "../session.js";

import { formatToolArgument } from "./formatters.js";
import { Tool } from "./types.js";

let store: Promise<HistoryStore> | undefined;

/**
 * The full-text index over the session transcripts, next to the sessions
 * folder (index/history.sqlite), shared with the VS Code extension. Opened
 * on first use.
 */
function historyStore(): Promise<HistoryStore> {
  const sessionsDir = getSessionDir();
  store ??= HistoryStore.open({
    dbPath: path.join(path.dirname(sessionsDir), "index", "history.sqlite"),
    sessionsDir,
    redact: redactSecretText,
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
    "Search the full transcript of this conversation, including turns that were compacted out of your context, or of earlier sessions. Use it to recover a requirement, a file path, an error or a decision from before a compaction. Every word must match. Results give each item's session and position; read them with ReadHistory.",
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
      return `${where} #${hit.ord} (${what}${state}): ${hit.snippet.replace(/\s+/g, " ")}`;
    });
    const notes = [
      ...(result.basic
        ? [
            "Basic search: this Node.js has no FTS5, so words match as substrings, newest first.",
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
  description: `Read items of a session transcript verbatim, by position, as SearchHistory reports them: from the first to the last position, at most ${MAX_READ} items. Secrets are redacted.`,
  parameters: {
    type: "object",
    required: ["from", "to"],
    properties: {
      session: {
        type: "string",
        description:
          "The session id from SearchHistory; this session by default",
      },
      from: { type: "number", description: "First position (#) to read" },
      to: { type: "number", description: "Last position (#) to read" },
    },
  },
  readonly: true,
  isBuiltIn: true,
  // Another session can be another project's
  requiresHumanApproval: (args) =>
    typeof args.session === "string" &&
    args.session !== getCurrentSession().sessionId,
  preprocess: async (args) => {
    const from = Number(args.from);
    const to = Number(args.to);
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < from
    ) {
      throw new Error("from and to must be positions with from <= to");
    }
    const session =
      typeof args.session === "string" && args.session
        ? args.session
        : getCurrentSession().sessionId;
    return {
      args: { session, from, to },
      preview: [
        {
          type: "text",
          content: `Will read #${from}-#${to} of ${session === getCurrentSession().sessionId ? "this session" : session}`,
        },
      ],
    };
  },
  run: async (args: {
    session: string;
    from: number;
    to: number;
  }): Promise<string> => {
    const items = await (
      await historyStore()
    ).read(
      args.session,
      args.from,
      Math.min(args.to, args.from + MAX_READ - 1),
    );
    if (!items.length) {
      return `Nothing at #${args.from}-#${args.to} of that session.`;
    }
    return items
      .map((item) => {
        const state = { live: "", folded: " (compacted)", cut: " (undone)" }[
          item.state
        ];
        return `#${item.ord}${state} ${item.text}`;
      })
      .join("\n\n");
  },
};
