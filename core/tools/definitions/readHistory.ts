import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const readHistoryTool: Tool = {
  type: "function",
  displayTitle: "Read History",
  wouldLikeTo: "read conversation history items {{{ from }}} to {{{ to }}}",
  isCurrently: "reading conversation history items {{{ from }}} to {{{ to }}}",
  hasAlready: "read conversation history items {{{ from }}} to {{{ to }}}",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.ReadHistory,
    description:
      "Read items of the full conversation transcript verbatim by position, including turns that were compacted out of your context. Use the positions that search_history returns. Secrets are redacted.",
    parameters: {
      type: "object",
      required: ["from"],
      properties: {
        session: {
          type: "string",
          description:
            "The session id from a search_history result. Leave out to read this conversation; reading another one asks the user first",
        },
        from: {
          type: "number",
          description: "The position of the first item, as in '#12'",
        },
        to: {
          type: "number",
          description:
            "The position of the last item. Defaults to 'from'. At most 40 items are returned",
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To read earlier items of the conversation verbatim, call the ${BuiltInToolNames.ReadHistory} tool with "from" and "to", the positions that ${BuiltInToolNames.SearchHistory} returned. For example:`,
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
