import { render, screen } from "@testing-library/react";
import { ToolCallState } from "core";
import { readHistoryTool } from "core/tools/definitions/readHistory";
import { searchHistoryTool } from "core/tools/definitions/searchHistory";
import { viewDiffTool } from "core/tools/definitions/viewDiff";
import { describe, expect, it } from "vitest";
import { ToolCallStatusMessage } from "./ToolCallStatusMessage";

function stateWithStatus(status: ToolCallState["status"]): ToolCallState {
  return {
    toolCallId: "test_id",
    toolCall: {
      id: "test_id",
      type: "function",
      function: { name: viewDiffTool.function.name, arguments: "{}" },
    },
    status,
    parsedArgs: {},
  };
}

describe("ToolCallStatusMessage", () => {
  it.each([
    ["generated", "NextCLI wants to view the git diff"],
    ["done", "NextCLI viewed the git diff"],
    ["canceled", "NextCLI tried to view the git diff"],
    ["errored", "NextCLI tried to view the git diff"],
  ] as const)("describes a %s tool call", (status, text) => {
    render(
      <ToolCallStatusMessage
        tool={viewDiffTool}
        toolCallState={stateWithStatus(status)}
      />,
    );
    expect(screen.getByTestId("tool-call-title")).toHaveTextContent(text);
  });

  it("keeps a title when the status template cannot render", () => {
    // An unclosed Mustache tag throws. The row must still describe the call.
    const tool = {
      ...viewDiffTool,
      wouldLikeTo: "view {{#unclosed",
      isCurrently: "getting {{#unclosed",
      hasAlready: "viewed {{#unclosed",
    };
    render(
      <ToolCallStatusMessage
        tool={tool}
        toolCallState={stateWithStatus("generated")}
      />,
    );
    expect(screen.getByTestId("tool-call-title")).toHaveTextContent(
      "NextCLI wants to use the View Diff tool",
    );
  });

  it("names an instant tool's call as done while it runs", () => {
    // view_diff is instant: it has no visible "is getting" phase
    render(
      <ToolCallStatusMessage
        tool={viewDiffTool}
        toolCallState={stateWithStatus("calling")}
      />,
    );
    expect(screen.getByTestId("tool-call-title")).toHaveTextContent(
      "NextCLI viewed the git diff",
    );
  });

  // Scope all and another conversation's id are what make these ask: the
  // line the user approves names them, and the defaults
  it.each([
    [
      searchHistoryTool,
      { query: "x" },
      'wants to search this conversation for "x"',
    ],
    [
      searchHistoryTool,
      { query: "x", scope: "all" },
      'wants to search saved conversations (scope: all) for "x"',
    ],
    [
      readHistoryTool,
      { from: 3 },
      "wants to read items #3 of this conversation",
    ],
    [
      readHistoryTool,
      { from: 0, to: 10, session: "abc-123" },
      "wants to read items #0 to #10 of conversation abc-123",
    ],
  ] as const)("names what %#. history call reaches", (tool, args, text) => {
    render(
      <ToolCallStatusMessage
        tool={tool}
        toolCallState={{ ...stateWithStatus("generated"), parsedArgs: args }}
      />,
    );
    expect(screen.getByTestId("tool-call-title")).toHaveTextContent(text);
  });

  // Exact lines: a plain string would also match a longer, wrong one
  it.each([
    [
      "generated",
      { outline: true },
      "NextCLI wants to read the outline of this conversation",
    ],
    [
      "generated",
      { outline: true, session: "abc-123", from: 100 },
      "NextCLI wants to read the outline of conversation abc-123 from #100",
    ],
    [
      "generated",
      { outline: true, from: 0, to: 9 },
      "NextCLI wants to read the outline of this conversation",
    ],
    [
      "done",
      { outline: true, session: "abc-123" },
      "NextCLI read the outline of conversation abc-123",
    ],
  ] as const)("names a %s outline of a conversation", (status, args, text) => {
    render(
      <ToolCallStatusMessage
        tool={readHistoryTool}
        toolCallState={{ ...stateWithStatus(status), parsedArgs: args }}
      />,
    );
    // A done call has no intro word, so its line has a double space
    expect(
      screen.getByTestId("tool-call-title").textContent?.replace(/\s+/g, " "),
    ).toBe(text);
  });
});
