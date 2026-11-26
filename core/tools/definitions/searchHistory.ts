import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const searchHistoryTool: Tool = {
  type: "function",
  displayTitle: "Search History",
  // The scope is what decides whether it asks: the line shows it, and the
  // default, so the approval names what will be searched
  wouldLikeTo:
    'search {{^scope}}this conversation{{/scope}}{{#scope}}saved conversations (scope: {{{ scope }}}){{/scope}} for "{{{ query }}}"',
  isCurrently:
    'searching {{^scope}}this conversation{{/scope}}{{#scope}}saved conversations (scope: {{{ scope }}}){{/scope}} for "{{{ query }}}"',
  hasAlready:
    'searched {{^scope}}this conversation{{/scope}}{{#scope}}saved conversations (scope: {{{ scope }}}){{/scope}} for "{{{ query }}}"',
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.SearchHistory,
    description:
      "Search the full transcript of this conversation, including turns that were compacted out of your context, or of earlier conversations. Items with every word come first, then items with some of them, marked with the words they lack. Words match whole, in any case, with common endings ('fix' finds 'fixed' and 'fixes', not 'prefix'), and inside identifiers ('config' finds 'loadConfig', 'id' finds 'getElementById'); common words such as 'the' or 'how' are skipped. Returns matching items with their position; read one in full with read_history. Secrets are redacted.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description:
            "Words to look for, such as a file name, an error message or an identifier. Phrases aren't supported: each word is matched on its own",
        },
        scope: {
          type: "string",
          enum: ["session", "workspace", "all"],
          description:
            "Where to search: 'session' (this conversation, the default), 'workspace' (earlier conversations in this workspace) or 'all' (every conversation on this machine; the user is asked first)",
        },
        limit: {
          type: "number",
          description: "How many matches to return, at most 20. Defaults to 10",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To find something said or done earlier in the conversation, including turns compacted out of your context, call the ${BuiltInToolNames.SearchHistory} tool with "query" and optionally "scope" and "limit". For example:`,
    exampleArgs: [
      ["query", "ECONNREFUSED"],
      ["scope", "session"],
    ],
  },
  toolCallIcon: "MagnifyingGlassIcon",
  evaluateToolCallPolicy: (
    basePolicy: ToolPolicy,
    parsedArgs: Record<string, unknown>,
  ): ToolPolicy => {
    // Other conversations may hold work from other projects: ask first
    if (
      basePolicy === "allowedWithoutPermission" &&
      parsedArgs?.scope === "all"
    ) {
      return "allowedWithPermission";
    }
    return basePolicy;
  },
};
