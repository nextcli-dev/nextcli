import { ToolPolicy } from "@continuedev/terminal-security";
import { Tool, ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { isTrustedFetchUrl } from "core/tools/policies/fetchAccess";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { isEditTool } from "../../util/toolCallState";
import {
  errorToolCall,
  setToolCallRememberRules,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { DEFAULT_TOOL_SETTING, ToolPolicies } from "../slices/uiSlice";
import { AppThunkDispatch } from "../store";

interface EvaluatedPolicy {
  policy: ToolPolicy;
  displayValue?: string;
  toolCallState: ToolCallState;
  /**
   * A terminal command whose every command is trusted or approved by the
   * evaluator on its own (isTrustedTerminalCommand in core)
   */
  trusted?: boolean;
  /** Rules that would let this terminal command run without asking */
  rememberRules?: string[];
}

/**
 * Evaluates the tool policy for a tool call, including dynamic policy evaluation
 * Note that tool group policies are not considered here because activeTools already excludes disabled groups
 */
async function evaluateToolPolicy(
  ideMessenger: IIdeMessenger,
  activeTools: Tool[],
  toolCallState: ToolCallState,
  toolPolicies: ToolPolicies,
  trustedCommands: readonly string[],
): Promise<EvaluatedPolicy> {
  // allow edit tool calls without permission
  if (isEditTool(toolCallState.toolCall.function.name)) {
    return { policy: "allowedWithoutPermission", toolCallState };
  }

  const basePolicy =
    toolPolicies[toolCallState.toolCall.function.name] ??
    activeTools.find(
      (tool) => tool.function.name === toolCallState.toolCall.function.name,
    )?.defaultToolPolicy ??
    DEFAULT_TOOL_SETTING;

  const toolName = toolCallState.toolCall.function.name;
  const result = await ideMessenger.request("tools/evaluatePolicy", {
    toolName,
    basePolicy,
    parsedArgs: toolCallState.parsedArgs,
    processedArgs: toolCallState.processedArgs,
    trustedCommands: [...trustedCommands],
  });

  // Evaluate the policy dynamically
  if (result.status === "error") {
    console.error(`Error evaluating tool policy for ${toolName}`, result.error);
    return { policy: "disabled", toolCallState };
  }

  const dynamicPolicy = result.content.policy;
  const { displayValue, trusted, rememberRules } = result.content;
  const trust = { trusted, rememberRules };

  // Ensure dynamic policy cannot be more lenient than base policy
  // Policy hierarchy (most restrictive to least): disabled > allowedWithPermission > allowedWithoutPermission
  if (basePolicy === "disabled") {
    return { policy: "disabled", displayValue, toolCallState }; // Cannot override disabled
  }
  if (
    basePolicy === "allowedWithPermission" &&
    dynamicPolicy === "allowedWithoutPermission"
  ) {
    return {
      policy: "allowedWithPermission",
      displayValue,
      toolCallState,
      ...trust,
    }; // Cannot make more lenient
  }

  return { policy: dynamicPolicy, displayValue, toolCallState, ...trust };
}

/**
 * A Run Terminal Command call that would ask runs without asking when core
 * found every command in it trusted (see terminalCommandTrust). Nothing else
 * changes: an excluded tool and a disabled command stay as they are.
 */
function trustTerminalCommand(evaluated: EvaluatedPolicy): EvaluatedPolicy {
  if (
    evaluated.policy === "allowedWithPermission" &&
    evaluated.trusted === true &&
    evaluated.toolCallState.toolCall.function.name ===
      BuiltInToolNames.RunTerminalCommand
  ) {
    return { ...evaluated, policy: "allowedWithoutPermission" };
  }
  return evaluated;
}

/**
 * A Read URL call that would ask runs without asking when its URL is on a
 * host the user trusts. Nothing else changes: an excluded tool stays
 * excluded, and other tools and untrusted URLs still ask.
 */
function trustFetchUrl(
  evaluated: EvaluatedPolicy,
  trustedFetchHosts: readonly string[],
): EvaluatedPolicy {
  const { toolCall, parsedArgs } = evaluated.toolCallState;
  const url: unknown = parsedArgs?.url;
  if (
    evaluated.policy === "allowedWithPermission" &&
    toolCall.function.name === BuiltInToolNames.FetchUrlContent &&
    typeof url === "string" &&
    isTrustedFetchUrl(url, trustedFetchHosts)
  ) {
    return { ...evaluated, policy: "allowedWithoutPermission" };
  }
  return evaluated;
}

/*
    1. Get arg-dependent tool policies from core
    2. Mark any disabled ones as errored
    3. Mark others as generated
*/
export async function evaluateToolPolicies(
  dispatch: AppThunkDispatch,
  ideMessenger: IIdeMessenger,
  activeTools: Tool[],
  generatedToolCalls: ToolCallState[],
  toolPolicies: ToolPolicies,
  trustedFetchHosts: readonly string[] = [],
  trustedCommands: readonly string[] = [],
): Promise<EvaluatedPolicy[]> {
  // Check if ALL tool calls are auto-approved using dynamic evaluation
  const policyResults = await Promise.all(
    generatedToolCalls.map(async (toolCallState) =>
      trustTerminalCommand(
        trustFetchUrl(
          await evaluateToolPolicy(
            ideMessenger,
            activeTools,
            toolCallState,
            toolPolicies,
            trustedCommands,
          ),
          trustedFetchHosts,
        ),
      ),
    ),
  );

  // A call that still asks offers "Allow & don't ask again" with these rules
  for (const { policy, rememberRules, toolCallState } of policyResults) {
    if (policy === "allowedWithPermission" && rememberRules?.length) {
      dispatch(
        setToolCallRememberRules({
          toolCallId: toolCallState.toolCallId,
          rememberRules,
        }),
      );
    }
  }

  const disabledResults = policyResults.filter(
    ({ policy }) => policy === "disabled",
  );

  for (const { displayValue, toolCallState } of disabledResults) {
    dispatch(errorToolCall({ toolCallId: toolCallState.toolCallId }));

    // Use the displayValue from the policy evaluation, or fallback to function name
    const command = displayValue || toolCallState.toolCall.function.name;

    // Add error message explaining why it's disabled
    dispatch(
      updateToolCallOutput({
        toolCallId: toolCallState.toolCallId,
        contextItems: [
          {
            icon: "problems",
            name: "Security Policy Violation",
            description: "Command Disabled",
            content: `This command has been disabled by security policy:\n\n${command}\n\nThis command cannot be executed as it may pose a security risk.`,
            hidden: false,
          },
        ],
      }),
    );
  }

  return policyResults;
}
