import { BuiltInToolNames } from "core/tools/builtIn";
import { useAppDispatch, useAppSelector } from "../../../../redux/hooks";
import { selectPendingToolCalls } from "../../../../redux/selectors/selectToolCalls";
import { addTrustedCommands } from "../../../../redux/slices/uiSlice";
import { callToolById } from "../../../../redux/thunks/callToolById";
import { cancelToolCallThunk } from "../../../../redux/thunks/cancelToolCall";
import { getMetaKeyLabel } from "../../../../util";
import { Button } from "../../../ui/Button";
import { useMainEditor } from "../../TipTapEditor/MainEditorProvider";
import { focusChatInput } from "../../focusChatInput";

export const generateToolCallButtonTestId = (
  action: "accept" | "reject" | "trust",
  toolCallId: string,
) => {
  return `${action}-tool-call-button-${toolCallId}`;
};

export function PendingToolCallToolbar() {
  const dispatch = useAppDispatch();
  const pendingToolCalls = useAppSelector(selectPendingToolCalls);
  const editor = useMainEditor();

  if (pendingToolCalls.length === 0) {
    return null;
  }

  const handleAccept = (toolCallId: string) => {
    void dispatch(callToolById({ toolCallId }));
  };

  // Trusts the rules core offered for this command, then runs it
  const handleTrust = (toolCallId: string, rules: string[]) => {
    dispatch(addTrustedCommands(rules));
    void dispatch(callToolById({ toolCallId }));
  };

  const handleReject = (toolCallId: string) => {
    // put cursor in editor after last rejection
    if (pendingToolCalls.length === 1) {
      focusChatInput(editor.mainEditor);
    }
    void dispatch(cancelToolCallThunk({ toolCallId }));
  };

  return (
    <div className="flex w-full flex-col pb-0.5">
      {pendingToolCalls.map((toolCall, index) => (
        <div
          key={toolCall.toolCallId}
          className="border-input bg-input flex flex-wrap items-center gap-2 rounded border"
        >
          <span className="text-description min-w-0 flex-[1_1_6rem] truncate text-xs italic">
            {toolCall.tool?.displayTitle ?? toolCall.toolCall.function.name}
          </span>

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-description-muted my-1 font-medium"
              onClick={() => handleReject(toolCall.toolCallId)}
              data-testid={generateToolCallButtonTestId(
                "reject",
                toolCall.toolCallId,
              )}
            >
              {index === 0 && (
                <span className="text-2xs mr-1">{getMetaKeyLabel()}⌫</span>
              )}
              <span>Reject</span>
            </Button>

            {toolCall.toolCall.function.name ===
              BuiltInToolNames.RunTerminalCommand &&
              !!toolCall.rememberRules?.length && (
                <Button
                  variant="outline"
                  size="sm"
                  className="my-1 font-medium"
                  title={`Trust ${toolCall.rememberRules.join(", ")} and don't ask again`}
                  onClick={() =>
                    handleTrust(
                      toolCall.toolCallId,
                      toolCall.rememberRules ?? [],
                    )
                  }
                  data-testid={generateToolCallButtonTestId(
                    "trust",
                    toolCall.toolCallId,
                  )}
                >
                  Allow & don't ask again
                </Button>
              )}

            <Button
              variant="primary"
              size="sm"
              className="my-1 font-medium"
              onClick={() => handleAccept(toolCall.toolCallId)}
              data-testid={generateToolCallButtonTestId(
                "accept",
                toolCall.toolCallId,
              )}
            >
              {index === 0 && (
                <span className="text-2xs mr-1">{getMetaKeyLabel()}⏎</span>
              )}
              <span>Accept</span>
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
