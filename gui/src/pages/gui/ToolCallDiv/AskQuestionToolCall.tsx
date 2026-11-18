import {
  ArrowRightIcon,
  CheckIcon,
  MinusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { DISMISS_TEXT, normalizeQuestionArgs } from "@nextcli/ask-question";
import { ToolCallState } from "core";
import { ComponentType, ReactNode, SVGProps, useMemo, useState } from "react";
import Spinner from "../../../components/gui/Spinner";
import { useAppSelector } from "../../../redux/hooks";
import { selectOpenQuestion } from "../../../redux/selectors/selectToolCalls";
import { cn } from "../../../util/cn";
import { ToggleWithIcon } from "./ToggleWithIcon";
import { ToolTruncateHistoryIcon } from "./ToolTruncateHistoryIcon";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const SuccessIcon: Icon = (props) => (
  <CheckIcon {...props} className={cn(props.className, "text-success")} />
);
const ErrorIcon: Icon = (props) => (
  <XMarkIcon {...props} className={cn(props.className, "text-error")} />
);

/**
 * The ask_question call in the chat history. The questions themselves are in
 * the panel that replaces the chat input; this row says what happened and
 * expands to the text the model got.
 */
export function AskQuestionToolCall({
  toolCallState,
  historyIndex,
}: {
  toolCallState: ToolCallState;
  historyIndex: number;
}) {
  const openQuestion = useAppSelector(selectOpenQuestion);
  const [open, setOpen] = useState(false);
  const count = useMemo(() => {
    try {
      return normalizeQuestionArgs(toolCallState.parsedArgs).questions.length;
    } catch {
      return 0;
    }
  }, [toolCallState.parsedArgs]);

  const output = (toolCallState.output ?? [])
    .map((item) => item.content)
    .join("\n\n");
  const asked = count > 1 ? `${count} questions` : "a question";

  let icon: Icon | undefined;
  let leading: ReactNode = null;
  let message: string;
  switch (toolCallState.status) {
    case "generating":
      leading = <Spinner />;
      message = "NextCLI is writing a question";
      break;
    case "generated":
      icon = ArrowRightIcon;
      message = "NextCLI wants to ask you a question";
      break;
    case "calling":
      if (openQuestion?.toolCallId === toolCallState.toolCallId) {
        leading = <Spinner />;
        message = `NextCLI is waiting for your answer${count > 1 ? ` · ${count} questions` : ""}`;
      } else {
        icon = MinusIcon;
        message = `NextCLI asked you ${asked} · not answered`;
      }
      break;
    case "done":
      icon = output === DISMISS_TEXT ? MinusIcon : SuccessIcon;
      message = `NextCLI asked you ${asked}${output === DISMISS_TEXT ? " · dismissed" : ""}`;
      break;
    case "errored":
      icon = ErrorIcon;
      message = "NextCLI tried to ask you a question";
      break;
    case "canceled":
      icon = ErrorIcon;
      message = "NextCLI tried to ask you a question · canceled";
      break;
  }

  const expandable = output !== "";

  return (
    <div
      className="mt-1 flex flex-col px-4"
      data-testid="ask-question-tool-call"
    >
      <div className="flex min-w-0 flex-row items-center justify-between gap-2">
        <div
          role={expandable ? "button" : undefined}
          aria-expanded={expandable ? open : undefined}
          onClick={expandable ? () => setOpen((prev) => !prev) : undefined}
          className={cn(
            "text-description flex min-w-0 flex-row items-center gap-1.5 text-xs",
            expandable && "cursor-pointer hover:brightness-125",
          )}
        >
          {leading ?? (
            <ToggleWithIcon icon={icon} isToggleable={expandable} open={open} />
          )}
          <span className="min-w-0 break-words" data-testid="tool-call-title">
            {message}
          </span>
        </div>
        {expandable && <ToolTruncateHistoryIcon historyIndex={historyIndex} />}
      </div>
      {expandable && open && (
        <div
          className="text-description border-command-border ml-2 mt-1.5 whitespace-pre-wrap break-words border-0 border-l-2 border-solid pl-3 text-xs"
          data-testid="ask-question-answers"
        >
          {output}
        </div>
      )}
    </div>
  );
}
