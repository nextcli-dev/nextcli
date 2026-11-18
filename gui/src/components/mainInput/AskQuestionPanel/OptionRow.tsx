import { CheckIcon } from "@heroicons/react/24/outline";
import { ReactNode } from "react";
import { cn } from "../../../util/cn";
import { FONT_STEP, useFontSize } from "../../ui/font";

/** Round for single choice, square for multiple choice, filled when picked. */
export function ChoiceBadge({
  multiSelect,
  selected,
  children,
}: {
  multiSelect: boolean;
  selected: boolean;
  children: ReactNode;
}) {
  const captionFont = useFontSize(FONT_STEP.caption);
  return (
    <span
      aria-hidden
      style={{ fontSize: captionFont }}
      className={cn(
        "mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center border border-solid tabular-nums",
        multiSelect ? "rounded" : "rounded-full",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-command-border text-description",
      )}
    >
      {children}
    </span>
  );
}

interface OptionRowProps {
  index: number;
  label: string;
  description?: string;
  multiSelect: boolean;
  selected: boolean;
  highlighted: boolean;
  onPick: () => void;
}

export function OptionRow({
  index,
  label,
  description,
  multiSelect,
  selected,
  highlighted,
  onPick,
}: OptionRowProps) {
  const controlFont = useFontSize(FONT_STEP.control);
  return (
    <div
      role={multiSelect ? "checkbox" : "radio"}
      aria-checked={selected}
      data-testid={`ask-question-option-${index}`}
      onClick={onPick}
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded px-1.5 py-1",
        selected
          ? "bg-list-active text-list-active-foreground"
          : "hover:bg-list-hover",
        highlighted &&
          "outline-command-border-focus outline outline-1 -outline-offset-1",
      )}
    >
      <ChoiceBadge multiSelect={multiSelect} selected={selected}>
        {selected && multiSelect ? (
          <CheckIcon className="h-3 w-3" />
        ) : (
          index + 1
        )}
      </ChoiceBadge>
      <span className="flex min-w-0 flex-col">
        <span className="break-words">{label}</span>
        {description && (
          <span
            className="text-description break-words"
            style={{ fontSize: controlFont }}
          >
            {description}
          </span>
        )}
      </span>
    </div>
  );
}
