// Abort controllers of in-flight conversation turns. On exit they are all
// aborted synchronously, so a tool call that arrives while the CLI is shutting
// down (e.g. during the telemetry flush after SIGINT) is never executed.
// Counted: a summary request runs a nested stream with its turn's controller,
// and its unregister must leave the turn registered.
const controllers = new Map<AbortController, number>();

let shuttingDown = false;

/**
 * Registers a controller to be aborted on exit. Returns a function that
 * undoes this registration once; the controller stays registered while any
 * other registration of it is open. A controller registered after shutdown
 * began is aborted immediately.
 */
export function registerAbortController(
  controller: AbortController,
): () => void {
  if (shuttingDown) {
    controller.abort();
    return () => {};
  }
  controllers.set(controller, (controllers.get(controller) ?? 0) + 1);
  let registered = true;
  return () => {
    if (!registered) {
      return;
    }
    registered = false;
    const count = (controllers.get(controller) ?? 0) - 1;
    if (count > 0) {
      controllers.set(controller, count);
    } else {
      controllers.delete(controller);
    }
  };
}

/**
 * Aborts every registered controller and any registered later
 */
export function abortAll(): void {
  shuttingDown = true;
  for (const controller of controllers.keys()) {
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
