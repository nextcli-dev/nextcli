import { useMemo } from "react";
import { useLocalStorage } from "../../context/LocalStorage";

export type FontSizeModifier = number | ((fontSize: number) => number);

/**
 * The GUI's type scale, as steps below the font-size setting (14px by
 * default). Answers use the setting itself.
 */
export const FONT_STEP = {
  /** Timeline rows (thinking, tool calls, waiting) and question text */
  row: -2,
  /** The input toolbar, menus and secondary text in panels */
  control: -3,
  /** Descriptions, hints, footers and badges */
  caption: -4,
} as const;

export const useFontSize = (modifier?: FontSizeModifier) => {
  const { fontSize } = useLocalStorage();
  return useMemo(() => {
    return !modifier
      ? fontSize
      : typeof modifier === "number"
        ? fontSize + modifier
        : modifier(fontSize);
  }, [fontSize]);
};
