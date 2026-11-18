import { logger } from "../util/logger.js";

type BeforeWriteHook = (paths: string[]) => Promise<void>;

let hook: BeforeWriteHook | undefined;

/** Set by the open turn, so undo can save files before tools change them. */
export function setBeforeFileWriteHook(next: BeforeWriteHook | undefined) {
  hook = next;
}

/**
 * File tools call this right before they write. Undo needs the bytes of
 * ignored files (a `.env`, a log) from before the write, because snapshots
 * leave ignored files out. Never throws: a tool never fails because of it.
 */
export async function beforeFileWrite(paths: string[]): Promise<void> {
  if (!hook) return;
  try {
    await hook(paths);
  } catch (error) {
    logger.debug("Could not save files before a write", { error, paths });
  }
}
