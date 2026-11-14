import { render, screen } from "@testing-library/react";
import { ToolCallState } from "core";
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
});
