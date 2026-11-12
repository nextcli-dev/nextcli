import { createAsyncThunk } from "@reduxjs/toolkit";
import { ApplyState, ApplyToFilePayload } from "core";
import { EDIT_MODE_STREAM_ID } from "core/edit/constants";
import { logAgentModeEditOutcome } from "../../util/editOutcomeLogger";
import {
  selectApplyStateByToolCallId,
  selectToolCallById,
} from "../selectors/selectToolCalls";
import { updateEditStateApplyState } from "../slices/editState";
import {
  acceptToolCall,
  errorToolCall,
  updateApplyState,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { findToolCallById, logToolUsage } from "../util";
import { exitEdit } from "./edit";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

export const handleApplyStateUpdate = createAsyncThunk<
  void,
  ApplyState,
  ThunkApiType
>(
  "apply/handleStateUpdate",
  async (applyState, { dispatch, getState, extra }) => {
    if (applyState.streamId === EDIT_MODE_STREAM_ID) {
      dispatch(updateEditStateApplyState(applyState));

      if (applyState.status === "closed") {
        const toolCallState = findToolCallById(
          getState().session.history,
          applyState.toolCallId!,
        );
        if (toolCallState) {
          logToolUsage(toolCallState, true, true, extra.ideMessenger);
        }
        void dispatch(exitEdit({}));
      }
    } else {
      // chat or agent
      dispatch(updateApplyState(applyState));

      // Handle apply status updates - use toolCallId from event payload
      if (applyState.toolCallId) {
        const toolCallState = findToolCallById(
          getState().session.history,
          applyState.toolCallId,
        );

        // Never auto-accept an apply result that looks like it destroyed the
        // file (e.g. the apply model answered in prose); leave the diff for
        // the user to review.
        if (
          applyState.status === "done" &&
          !applyState.destructiveWarning &&
          toolCallState?.toolCall.function.name &&
          getState().ui.toolSettings[toolCallState.toolCall.function.name] ===
            "allowedWithoutPermission"
        ) {
          extra.ideMessenger.post("acceptDiff", {
            streamId: applyState.streamId,
            filepath: applyState.filepath,
          });
        }

        if (applyState.status === "closed") {
          if (toolCallState) {
            const accepted =
              toolCallState.status !== "canceled" &&
              !applyState.interruptedByUserEdit;

            logToolUsage(toolCallState, accepted, true, extra.ideMessenger);

            // Log edit outcome for Agent Mode
            const newApplyState =
              getState().session.codeBlockApplyStates.states.find(
                (s) => s.streamId === applyState.streamId,
              );
            const newState = getState();
            if (newApplyState) {
              void logAgentModeEditOutcome(
                newState.session.history,
                newState.config.config,
                toolCallState,
                newApplyState,
                accepted,
                extra.ideMessenger,
              );
            }

            if (
              applyState.interruptedByUserEdit &&
              toolCallState.status !== "canceled"
            ) {
              // Mark it errored so the agent continues and sees why
              dispatch(
                errorToolCall({
                  toolCallId: applyState.toolCallId,
                  output: [
                    {
                      icon: "warning",
                      name: "Edit Interrupted",
                      description:
                        "The file was changed while the edit was applied",
                      content: `The edit to ${applyState.filepath} was not applied: the user changed the file while the edit was being applied, so it was stopped and reverted. The user's changes were kept. Read the file again before making further changes.`,
                      hidden: false,
                    },
                  ],
                }),
              );
              void dispatch(
                streamResponseAfterToolCall({
                  toolCallId: applyState.toolCallId,
                }),
              );
            } else if (accepted) {
              if (toolCallState.status !== "errored") {
                dispatch(
                  acceptToolCall({
                    toolCallId: applyState.toolCallId,
                  }),
                );

                // The user kept a result that looked like it destroyed the
                // file, so tell the model instead of reporting a clean edit
                const destructiveWarning =
                  applyState.destructiveWarning ??
                  newApplyState?.destructiveWarning;
                if (destructiveWarning) {
                  dispatch(
                    updateToolCallOutput({
                      toolCallId: applyState.toolCallId,
                      contextItems: [
                        {
                          icon: "warning",
                          name: "Edit May Be Destructive",
                          description:
                            "The applied edit replaced most of the file",
                          content: `The edit to ${applyState.filepath} was applied, but it looked destructive: ${destructiveWarning}\n\nRead the file again and check that no code was lost before making further changes.`,
                          hidden: false,
                        },
                      ],
                    }),
                  );
                } else if (applyState.autoFormattingDiff) {
                  // Add autoformatting diff to tool output if present
                  dispatch(
                    updateToolCallOutput({
                      toolCallId: applyState.toolCallId,
                      contextItems: [
                        {
                          icon: "info",
                          name: "Auto-formatting Applied",
                          description: "Editor auto-formatting changes",
                          content: `Along with your edits, the editor applied the following auto-formatting:\n\n${applyState.autoFormattingDiff}\n\n(Note: Pay close attention to changes such as single quotes being converted to double quotes, semicolons being removed or added, long lines being broken into multiple lines, adjusting indentation style, adding/removing trailing commas, etc. This will help you ensure future SEARCH/REPLACE operations to this file are accurate.)`,
                          hidden: false,
                        },
                      ],
                    }),
                  );
                } else {
                  dispatch(
                    updateToolCallOutput({
                      toolCallId: applyState.toolCallId,
                      contextItems: [
                        {
                          name: "Edit Success",
                          content: `Successfully edited ${applyState.filepath}`,
                          description: "",
                          hidden: true,
                        },
                      ],
                    }),
                  );
                }
              } else if (!toolCallState.output?.length) {
                // Keep the output of whatever errored the call (such as the
                // "Apply Error" from applyForEditTool): it says what went wrong
                const filepath = applyState.filepath ?? newApplyState?.filepath;
                dispatch(
                  updateToolCallOutput({
                    toolCallId: applyState.toolCallId,
                    contextItems: [
                      {
                        name: "Edit Failed",
                        content: `Failed to edit ${filepath ?? "the file"}. To continue working with the file, read it again to see the most up-to-date contents`,
                        description: "",
                        hidden: true,
                      },
                    ],
                  }),
                );
              }

              void dispatch(
                streamResponseAfterToolCall({
                  toolCallId: applyState.toolCallId,
                }),
              );
            }
          }
        }
      }
    }
  },
);

export const applyForEditTool = createAsyncThunk<
  void,
  ApplyToFilePayload & { toolCallId: string },
  ThunkApiType
>("apply/editTool", async (payload, { dispatch, getState, extra }) => {
  const { toolCallId, streamId } = payload;
  dispatch(
    updateApplyState({
      streamId,
      toolCallId,
      status: "not-started",
    }),
  );

  let didError = false;
  let errorMessage: string | undefined;
  try {
    const response = await extra.ideMessenger.request("applyToFile", payload);
    if (response.status === "error") {
      didError = true;
      errorMessage = response.error;
    }
  } catch (e) {
    didError = true;
    errorMessage = e instanceof Error ? e.message : String(e);
  }
  if (didError) {
    const state = getState();

    const toolCallState = selectToolCallById(state, toolCallId);
    const applyState = selectApplyStateByToolCallId(state, toolCallId);
    if (
      toolCallState &&
      applyState &&
      applyState.status !== "closed" &&
      toolCallState.status === "calling"
    ) {
      dispatch(
        errorToolCall({
          toolCallId,
        }),
      );
      dispatch(
        updateToolCallOutput({
          toolCallId,
          contextItems: [
            {
              icon: "problems",
              name: "Apply Error",
              description: "Failed to apply changes",
              content: `Error editing ${payload.filepath ?? "file"}: ${errorMessage || "failed to apply changes to file."}\n\nPlease try again with correct args or notify the user and request further instructions.`,
              hidden: false,
            },
          ],
        }),
      );
      void dispatch(
        handleApplyStateUpdate({
          status: "closed",
          streamId: applyState.streamId,
          toolCallId,
          filepath: payload.filepath,
        }),
      );
    }
  }
});
