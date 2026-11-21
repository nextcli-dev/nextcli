import { Box, type DOMElement, Text, useBoxMetrics } from "ink";
import React, { useRef } from "react";

interface ClipToFitProps {
  /** Which end stays visible when the content is taller than the rows left */
  keep: "start" | "end";
  /** The note shown in place of the hidden rows, given how many there are */
  note: (hiddenRows: number) => string;
  /** At most this many rows, the note included; else the rows its parent leaves */
  maxRows?: number;
  children: React.ReactNode;
}

/**
 * Clips its content to the rows it gets, counted as rendered rows (wrapped
 * lines included): `maxRows`, or else what its parent leaves when it shrinks.
 * TUIChat caps the frame below the terminal height, since Ink clears and
 * redraws the whole screen on every frame as tall as the terminal; parts
 * that can give up rows use this.
 */
export const ClipToFit: React.FC<ClipToFitProps> = ({
  keep,
  note,
  maxRows,
  children,
}) => {
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const hiddenRows = content.height - viewport.height;
  const hint = hiddenRows > 0 && (
    <Box flexShrink={0}>
      <Text color="dim">{note(hiddenRows)}</Text>
    </Box>
  );

  return (
    <Box flexDirection="column" overflowY="hidden" maxHeight={maxRows}>
      {keep === "end" && hint}
      <Box
        ref={viewportRef}
        flexDirection="column"
        overflowY="hidden"
        justifyContent={keep === "end" ? "flex-end" : "flex-start"}
      >
        <Box ref={contentRef} flexDirection="column" flexShrink={0}>
          {children}
        </Box>
      </Box>
      {keep === "start" && hint}
    </Box>
  );
};

export const linesWord = (count: number) =>
  `${count} more ${count === 1 ? "line" : "lines"}`;
