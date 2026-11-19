import { ArrowRightIcon } from "@heroicons/react/24/outline";
import { ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { useState } from "react";
import { useAppSelector } from "../../../redux/hooks";
import { RootState } from "../../../redux/store";
import { AskQuestionToolCall } from "./AskQuestionToolCall";
import FunctionSpecificToolCallDiv from "./FunctionSpecificToolCallDiv";
import { GroupedToolCallHeader } from "./GroupedToolCallHeader";
import { McpAppRenderer } from "./MCPAppRenderer";
import { SimpleToolCallUI } from "./SimpleToolCallUI";
import { ToolCallDisplay } from "./ToolCallDisplay";
import { getIconByName, getStatusIcon } from "./utils";

interface ToolCallDivProps {
  toolCallStates: ToolCallState[];
  historyIndex: number;
}

export function ToolCallDiv({
  toolCallStates,
  historyIndex,
}: ToolCallDivProps) {
  const [open, setOpen] = useState(true);
  const availableTools = useAppSelector(
    (state: RootState) => state.config.config.tools,
  );

  if (!toolCallStates?.length) return null;

  // Grouped as soon as there are several calls, also while their arguments
  // stream, so the calls don't re-layout into the group when they finish
  const shouldShowGroupedUI = toolCallStates.length > 1;
  const activeCalls = toolCallStates.filter(
    (call) => call.status !== "canceled",
  );
  const pendingCalls = toolCallStates.filter((call) => call.status !== "done");

  const renderToolCall = (toolCallState: ToolCallState) => {
    const tool = availableTools.find(
      (tool) => toolCallState.toolCall.function?.name === tool.function.name,
    );
    const functionName = toolCallState.toolCall.function?.name;
    const icon =
      functionName && tool?.toolCallIcon
        ? getIconByName(tool.toolCallIcon)
        : undefined;

    if (functionName === BuiltInToolNames.AskQuestion) {
      return (
        <AskQuestionToolCall
          toolCallState={toolCallState}
          historyIndex={historyIndex}
        />
      );
    }

    if (toolCallState.mcpUiState) {
      return (
        <ToolCallDisplay
          icon={getStatusIcon(toolCallState.status)}
          tool={tool}
          toolCallState={toolCallState}
          historyIndex={historyIndex}
        >
          <McpAppRenderer toolCallState={toolCallState} />
        </ToolCallDisplay>
      );
    }

    if (icon) {
      return (
        <SimpleToolCallUI
          tool={tool}
          toolCallState={toolCallState}
          icon={toolCallState.status === "generated" ? ArrowRightIcon : icon}
          historyIndex={historyIndex}
        />
      );
    }

    // Trying this out while it's an experimental feature
    // Obviously missing the truncate and args buttons
    // All the info from args is displayed here
    // But we'd need a nicer place to put the truncate button and the X icon when tool call fails
    if (
      functionName === BuiltInToolNames.SingleFindAndReplace ||
      functionName === BuiltInToolNames.MultiEdit ||
      functionName === BuiltInToolNames.RunTerminalCommand
    ) {
      return (
        <div className="flex flex-col px-1">
          <FunctionSpecificToolCallDiv
            toolCallState={toolCallState}
            historyIndex={historyIndex}
          />
        </div>
      );
    }

    return (
      <ToolCallDisplay
        icon={getStatusIcon(toolCallState.status)}
        tool={tool}
        toolCallState={toolCallState}
        historyIndex={historyIndex}
      >
        <FunctionSpecificToolCallDiv
          toolCallState={toolCallState}
          historyIndex={historyIndex}
        />
      </ToolCallDisplay>
    );
  };

  if (shouldShowGroupedUI) {
    return (
      <div className="border-border rounded-lg border px-4 py-3 pb-0">
        <GroupedToolCallHeader
          toolCallStates={toolCallStates}
          activeCalls={pendingCalls.length > 0 ? pendingCalls : activeCalls}
          open={open}
          onToggle={() => setOpen(!open)}
        />
        {/* As tall as its calls: the chat is the only scroll, so live
            output stays in view instead of growing inside a capped box */}
        <div data-testid="tool-call-group-body" hidden={!open}>
          {toolCallStates.map((toolCallState) => (
            <div className="py-1 pl-6" key={toolCallState.toolCallId}>
              {renderToolCall(toolCallState)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return toolCallStates.map((toolCallState) => (
    <div className="py-1" key={toolCallState.toolCallId}>
      {renderToolCall(toolCallState)}
    </div>
  ));
}
