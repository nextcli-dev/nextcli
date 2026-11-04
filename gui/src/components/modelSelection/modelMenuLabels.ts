import type { SerializedModelControls } from "core";

type ThinkingMode = "off" | "hidden" | "shown";

const EFFORT_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLabel(effort: string | undefined): string {
  return effort ? (EFFORT_LABELS[effort] ?? effort) : "Default";
}

export const THINKING_MODES: ThinkingMode[] = ["off", "hidden", "shown"];

const THINKING_LABELS: Record<ThinkingMode, string> = {
  off: "Off",
  hidden: "Hidden",
  shown: "Shown",
};

const THINKING_DESCRIPTIONS: Record<ThinkingMode, string> = {
  off: "No thinking tokens are used.",
  hidden: "Thinks, but the text isn't shown.",
  shown: "Thinks and streams the text.",
};

export function thinkingLabel(mode: ThinkingMode | undefined): string {
  return mode ? THINKING_LABELS[mode] : "Default";
}

export function thinkingDescription(mode: ThinkingMode): string {
  return THINKING_DESCRIPTIONS[mode];
}

export function formatContextLength(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(2))}M`
    : `${Math.round(tokens / 1000)}K`;
}

/** Which settings rows the menu shows for a model */
export function visibleSettingRows(
  controls: SerializedModelControls | undefined,
) {
  return {
    fast: !!controls?.fast,
    thinking: (controls?.thinkingModes.length ?? 0) > 0,
    effort: (controls?.efforts.length ?? 0) > 0,
    context: (controls?.contextOptions.length ?? 0) > 1,
  };
}
