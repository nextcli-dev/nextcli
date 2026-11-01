// Abort controllers of in-flight conversation turns. On exit they are all
// aborted synchronously, so a tool call that arrives while the CLI is shutting
// down (e.g. during the telemetry flush after SIGINT) is never executed.
const controllers = new Set<AbortController>();

let shuttingDown = false;

/**
 * Registers a controller to be aborted on exit. Returns a function that
 * unregisters it. A controller registered after shutdown began is aborted
 * immediately.
 */
export function registerAbortController(
  controller: AbortController,
): () => void {
  if (shuttingDown) {
    controller.abort();
    return () => {};
  }
  controllers.add(controller);
  return () => {
    controllers.delete(controller);
  };
}

/**
 * Aborts every registered controller and any registered later
 */
export function abortAll(): void {
  shuttingDown = true;
  for (const controller of controllers) {
    controller.abort();
  }
  controllers.clear();
}

/**
 * Resets the registry. Only for tests.
 */
export function resetAbortRegistryForTests(): void {
  shuttingDown = false;
  controllers.clear();
}
