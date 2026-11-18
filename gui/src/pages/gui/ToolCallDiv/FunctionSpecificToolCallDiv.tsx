import { ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { EditOperation } from "core/tools/definitions/multiEdit";
import { useMemo } from "react";
import { CreateFile } from "./CreateFile";
import { EditFile } from "./EditFile";
import { FindAndReplaceDisplay } from "./FindAndReplace";
import { RunTerminalCommand } from "./RunTerminalCommand";

const NO_EDITS: EditOperation[] = [];

function FunctionSpecificToolCallDiv({
  toolCallState,
  historyIndex,
}: {
  toolCallState: ToolCallState;
  historyIndex: number;
}) {
  const args = toolCallState.parsedArgs;
  const processedArgs = toolCallState.processedArgs;
  const toolCall = toolCallState.toolCall;

  // Memoized so FindAndReplaceDisplay's diff memo can hit across renders
  const oldString = processedArgs?.old_string ?? args?.old_string ?? "";
  const newString = processedArgs?.new_string ?? args?.new_string ?? "";
  const replaceAll = processedArgs?.replace_all ?? args?.replace_all;
  const singleEdits: EditOperation[] = useMemo(
    () => [
      { old_string: oldString, new_string: newString, replace_all: replaceAll },
    ],
    [oldString, newString, replaceAll],
  );

  switch (toolCall.function?.name) {
    case BuiltInToolNames.CreateNewFile:
      return (
        <CreateFile
          relativeFilepath={args?.filepath ?? ""}
          fileContents={args?.contents ?? ""}
          historyIndex={historyIndex}
        />
      );
    case BuiltInToolNames.EditExistingFile:
      return (
        <EditFile
          relativeFilePath={processedArgs?.filepath ?? args?.filepath ?? ""}
          changes={processedArgs?.changes ?? args?.changes ?? ""}
          toolCallId={toolCall.id}
          historyIndex={historyIndex}
        />
      );
    case BuiltInToolNames.SingleFindAndReplace:
      return (
        <FindAndReplaceDisplay
          editingFileContents={processedArgs?.editingFileContents}
          fileUri={processedArgs?.fileUri ?? ""}
          newFileContents={processedArgs?.newFileContents}
          relativeFilePath={processedArgs?.filepath ?? args?.filepath ?? ""}
          edits={singleEdits}
          toolCallId={toolCall.id}
          historyIndex={historyIndex}
        />
      );
    case BuiltInToolNames.MultiEdit:
      return (
        <FindAndReplaceDisplay
          editingFileContents={processedArgs?.editingFileContents}
          relativeFilePath={processedArgs?.filepath ?? args?.filepath ?? ""}
          fileUri={processedArgs?.fileUri ?? ""}
          newFileContents={processedArgs?.newFileContents}
          edits={processedArgs?.edits ?? args?.edits ?? NO_EDITS}
          toolCallId={toolCall.id}
          historyIndex={historyIndex}
        />
      );
    case BuiltInToolNames.RunTerminalCommand:
      return (
        <RunTerminalCommand
          command={args?.command ?? ""}
          toolCallState={toolCallState}
          toolCallId={toolCall.id}
        />
      );
    default:
      return null;
  }
}

export default FunctionSpecificToolCallDiv;
