import { screen } from "@testing-library/react";
import { ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../../util/test/render";
import { ToolCallDiv } from ".";

vi.mock("./FunctionSpecificToolCallDiv", () => ({
  default: ({ toolCallState }: { toolCallState: ToolCallState }) => (
    <div data-testid="tool-call">{toolCallState.parsedArgs?.command}</div>
  ),
}));

const terminalCall = (
  id: string,
  command: string,
  status: ToolCallState["status"],
): ToolCallState => ({
  toolCallId: id,
  toolCall: {
    id,
    type: "function",
    function: {
      name: BuiltInToolNames.RunTerminalCommand,
      arguments: JSON.stringify({ command }),
    },
  },
  status,
  parsedArgs: { command },
});

describe("ToolCallDiv", () => {
  it("groups several calls while their arguments still stream", async () => {
    await renderWithProviders(
      <ToolCallDiv
        historyIndex={0}
        toolCallStates={[
          terminalCall("a", "git log", "generated"),
          terminalCall("b", "ls -l", "generating"),
        ]}
      />,
    );
    expect(screen.getByTestId("performing-actions")).toBeInTheDocument();
    expect(screen.getAllByTestId("tool-call")).toHaveLength(2);
  });

  it("lets the open group grow with its calls instead of scrolling inside it", async () => {
    const { user } = await renderWithProviders(
      <ToolCallDiv
        historyIndex={0}
        toolCallStates={[
          terminalCall("a", "git log", "done"),
          terminalCall("b", "ls -l", "calling"),
        ]}
      />,
    );
    const body = screen.getByTestId("tool-call-group-body");
    expect(body.className).not.toMatch(/max-h|overflow/);
    expect(body).toBeVisible();

    // Closing the group hides its calls, and opening shows them again
    await user.click(screen.getByTestId("performing-actions"));
    expect(body).not.toBeVisible();
    await user.click(screen.getByTestId("performing-actions"));
    expect(body).toBeVisible();
  });

  it("shows a single call on its own", async () => {
    await renderWithProviders(
      <ToolCallDiv
        historyIndex={0}
        toolCallStates={[terminalCall("a", "git log", "generating")]}
      />,
    );
    expect(screen.queryByTestId("performing-actions")).not.toBeInTheDocument();
    expect(screen.getByTestId("tool-call")).toHaveTextContent("git log");
  });
});
