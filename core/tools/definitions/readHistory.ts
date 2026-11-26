import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

const CONVERSATION =
  "{{#session}}conversation {{{ session }}}{{/session}}{{^session}}this conversation{{/session}}";
const WHAT =
  `{{#outline}}the outline of ${CONVERSATION}{{#from}} from #{{{ from }}}{{/from}}{{/outline}}` +
  `{{^outline}}items #{{{ from }}}{{#to}} to #{{{ to }}}{{/to}} of ${CONVERSATION}{{/outline}}`;

export const readHistoryTool: Tool = {
  type: "function",
  displayTitle: "Read History",
  // Another conversation's id is what makes it ask: the line names it, and
  // the default. Mustache treats 0 as missing, so "to" is left out when it
  // is 0, and so is "from" in an outline, where 0 is the default
  wouldLikeTo: `read ${WHAT}`,
  isCurrently: `reading ${WHAT}`,
  hasAlready: `read ${WHAT}`,
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.ReadHistory,
    description:
      "Read items of the full conversation transcript verbatim by position, including turns that were compacted out of your context. Use the positions that search_history returns. With outline: true it lists the conversation's user messages and compaction summaries instead, with their positions and first words: use it to find the part of a long conversation to read. Secrets are redacted.",
    parameters: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description:
            "The session id from a search_history result. Leave out to read this conversation; reading another one asks the user first",
        },
        from: {
          type: "number",
          description:
            "The position of the first item, as in '#12'. With outline, the position to list from (0 by default)",
        },
        to: {
          type: "number",
          description:
            "The position of the last item. Defaults to 'from'. At most 40 items and about 80,000 characters are returned; when a limit stops the read, the result says where to read on. Not used with outline",
        },
        outline: {
          type: "boolean",
          description:
            "List the conversation's user messages and compaction summaries instead of reading items",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To read earlier items of the conversation verbatim, call the ${BuiltInToolNames.ReadHistory} tool with "from" and "to", the positions that ${BuiltInToolNames.SearchHistory} returned; to see where things happened in a long conversation, call it with "outline" set to true. For example:`,
    exampleArgs: [
      ["from", "12"],
      ["to", "14"],
    ],
  },
  toolCallIcon: "ClockIcon",
  evaluateToolCallPolicy: (
    basePolicy: ToolPolicy,
    parsedArgs: Record<string, unknown>,
  ): ToolPolicy => {
    // A session named here is another one: search_history shows "this
    // session" for the open one, and the call leaves `session` out for it
    const session = parsedArgs?.session;
    if (
      basePolicy === "allowedWithoutPermission" &&
      typeof session === "string" &&
      session.trim() !== ""
    ) {
      return "allowedWithPermission";
    }
    return basePolicy;
  },
};
