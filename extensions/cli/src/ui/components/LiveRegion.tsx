import { Box, type DOMElement, Text, useBoxMetrics } from "ink";
import React, { useRef } from "react";

/**
 * The part of the chat that still changes while a turn runs. It shrinks to
 * the rows the rest of the screen leaves (TUIChat caps the frame below the
 * terminal height) and then shows the newest lines. Ink clears and redraws
 * the whole screen on every frame as tall as the terminal, so the live frame
 * must never get there. The full text is printed once it stops changing.
 */
export const LiveRegion: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const viewportRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const hiddenRows = content.height - viewport.height;

  return (
    <Box flexDirection="column" overflowY="hidden">
      {hiddenRows > 0 && (
        <Box flexShrink={0}>
          <Text color="dim">
            ↑ {hiddenRows} more {hiddenRows === 1 ? "line" : "lines"}, shown in
            full when this step finishes
          </Text>
        </Box>
      )}
      <Box
        ref={viewportRef}
        flexDirection="column"
        overflowY="hidden"
        justifyContent="flex-end"
      >
        <Box ref={contentRef} flexDirection="column" flexShrink={0}>
          {children}
        </Box>
      </Box>
    </Box>
  );
};
