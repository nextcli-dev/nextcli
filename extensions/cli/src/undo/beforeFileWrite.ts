import { logger } from "../util/logger.js";

type BeforeWriteHook = (paths: string[]) => Promise<void>;

let hook: BeforeWriteHook | undefined;

export function setBeforeFileWriteHook(next: BeforeWriteHook | undefined) {
  hook = next;
}

/** Saves ignored files before a tool writes them. Never throws. */
export async function beforeFileWrite(paths: string[]): Promise<void> {
  if (!hook) return;
  try {
    await hook(paths);
  } catch (error) {
    logger.debug("Could not save files before a write", { error, paths });
  }
}
