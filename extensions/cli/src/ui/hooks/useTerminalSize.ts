import { useStdout } from "ink";
import { useEffect, useState } from "react";

const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;

// Ink types stdout as any writable stream; a TTY also has columns and rows
function readSize(stdout: NodeJS.WritableStream) {
  const { columns, rows } = stdout as Partial<
    Pick<NodeJS.WriteStream, "columns" | "rows">
  >;
  return { columns: columns || DEFAULT_COLS, rows: rows || DEFAULT_ROWS };
}

const useTerminalSize = (debounce = 100) => {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState(() => readSize(stdout));
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    let debounceTimer: NodeJS.Timeout | null = null;

    const handleResize = () => {
      setIsResizing(true);

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(() => {
        setDimensions(readSize(stdout));
        setIsResizing(false);
      }, debounce);
    };

    stdout.on("resize", handleResize);
    return () => {
      stdout.removeListener("resize", handleResize);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [stdout, debounce]);

  return { ...dimensions, isResizing };
};

export { useTerminalSize };
