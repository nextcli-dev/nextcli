import { EventEmitter } from "node:events";

import { render } from "ink";
import type React from "react";

// Escape sequences that wipe the screen or the scrollback: CSI 2J, CSI 3J,
// and Ink's own full-frame clear (cursor home, then erase down)
const SCREEN_CLEAR = /\u001b\[2J|\u001b\[3J|\u001b\[1;1H\u001b\[0?J/;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** A terminal with a size, unlike ink-testing-library's stream */
export class FakeTtyStdout extends EventEmitter {
  readonly isTTY = true;
  readonly writes: string[] = [];

  constructor(
    public columns = 80,
    public rows = 20,
  ) {
    super();
  }

  write(chunk: string | Uint8Array): boolean {
    this.writes.push(String(chunk));
    return true;
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }

  /** Everything written since `mark`, an index into `writes` */
  outputSince(mark = 0): string {
    return this.writes.slice(mark).join("");
  }

  /** Writes since `mark` that clear the screen or the scrollback */
  screenClearsSince(mark = 0): number {
    return this.writes.slice(mark).filter((w) => SCREEN_CLEAR.test(w)).length;
  }

  /** The last write that contains `marker`, without escape sequences */
  lastWriteWith(marker: string): string {
    const write = [...this.writes].reverse().find((w) => w.includes(marker));
    return write?.replace(ANSI, "") ?? "";
  }

  /** Lines in the tallest write since `mark` that contains `marker` */
  tallestWriteWith(marker: string, mark = 0): number {
    return Math.max(
      0,
      ...this.writes
        .slice(mark)
        .filter((w) => w.includes(marker))
        .map((w) => w.replace(ANSI, "").replace(/\n$/, "").split("\n").length),
    );
  }
}

export class FakeTtyStdin extends EventEmitter {
  readonly isTTY = true;
  private pending: string | null = null;

  write(data: string): void {
    this.pending = data;
    this.emit("readable");
    this.emit("data", data);
  }

  read(): string | null {
    const data = this.pending;
    this.pending = null;
    return data;
  }

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

/**
 * Renders with real Ink into a fake terminal, interactive as in a real one
 * (Ink treats CI as non-interactive and then skips its redraw logic).
 */
export function renderInTty(
  element: React.ReactElement,
  { columns = 80, rows = 20 }: { columns?: number; rows?: number } = {},
) {
  const stdout = new FakeTtyStdout(columns, rows);
  const stdin = new FakeTtyStdin();
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return { stdout, stdin, ...instance };
}
