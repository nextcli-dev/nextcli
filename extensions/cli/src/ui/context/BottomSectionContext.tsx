import { createContext } from "react";

/**
 * The fixed section below the chat: its rendered height and the most rows
 * it may take (one less than the terminal). It can't shrink, so content
 * that can give up rows, like a permission prompt's preview, sizes itself
 * from these. Absent outside TUIChat, where nothing limits the height.
 */
export const BottomSectionContext = createContext<{
  height: number;
  maxRows: number;
} | null>(null);
