/**
 * Thrown when a tool call is interrupted (e.g. SIGINT) before the tool runs,
 * so it is recorded as canceled rather than as a tool error
 */
export class ToolInterruptedError extends Error {
  constructor() {
    super("Interrupted before the tool ran");
    this.name = "ToolInterruptedError";
  }
}
