import { Tool, ToolCallState } from "core";
import Mustache from "mustache";
import { getStatusIntro } from "./utils";

interface ToolCallStatusMessageProps {
  tool: Tool | undefined;
  toolCallState: ToolCallState;
}

/** Mustache throws on an unclosed tag. A status line must not take the row with it. */
function renderStatus(
  template: string | undefined,
  args: unknown,
  fallback: string,
): string {
  if (!template) return fallback;
  try {
    return Mustache.render(template, args ?? {});
  } catch {
    return fallback;
  }
}

export function ToolCallStatusMessage({
  tool,
  toolCallState,
}: ToolCallStatusMessageProps) {
  if (!tool) return "Agent tool use";

  const toolName = tool.displayTitle ?? tool.function.name;
  const defaultToolDescription = `${toolName} tool`;
  const useFallback = `use the ${defaultToolDescription}`;
  const usedFallback = `used the ${defaultToolDescription}`;
  const callingFallback = `calling the ${defaultToolDescription}`;

  const futureMessage = renderStatus(
    tool.wouldLikeTo,
    toolCallState.parsedArgs,
    useFallback,
  );
  // TODO go back and replace arg string values and tool names with <code> tags
  // to make them more readable

  let intro = getStatusIntro(toolCallState.status, tool.isInstant);
  let message = "";

  // Handle the special case for "done" status or instant tools that are calling
  if (
    toolCallState.status === "done" ||
    (tool.isInstant && toolCallState.status === "calling")
  ) {
    message = renderStatus(
      tool.hasAlready,
      toolCallState.parsedArgs,
      usedFallback,
    );
  } else {
    switch (toolCallState.status) {
      case "generating":
      case "generated":
      case "canceled":
      case "errored":
        message = futureMessage;
        break;
      case "calling":
        message = renderStatus(
          tool.isCurrently,
          toolCallState.parsedArgs,
          callingFallback,
        );
        break;
      default:
        message = defaultToolDescription;
    }
  }

  return (
    <div
      className="text-description line-clamp-4 min-w-0 break-words"
      data-testid="tool-call-title"
    >
      {`NextCLI ${intro} ${message}`}
    </div>
  );
}
