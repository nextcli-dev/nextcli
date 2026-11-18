import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { FONT_STEP, useFontSize } from "../../../components/ui/font";

interface IndicatorBarProps {
  text: string;
  isExpanded: boolean;
}

export function IndicatorBar({ text, isExpanded }: IndicatorBarProps) {
  const controlFont = useFontSize(FONT_STEP.control);
  return (
    <div className="absolute left-0 right-0 top-0 z-10 flex h-8 items-start justify-center pt-1">
      <div
        className="border-border bg-editor text-description flex items-center gap-2 rounded border px-2 py-1 shadow-sm"
        style={{ fontSize: controlFont }}
      >
        <span>{text}</span>
        <ChevronDownIcon
          className={`text-description h-3 w-3 ${isExpanded ? "" : "rotate-180"}`}
        />
      </div>
    </div>
  );
}
