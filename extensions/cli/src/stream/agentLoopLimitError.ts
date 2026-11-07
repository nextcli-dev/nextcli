import type { AgentLoopLimitKind, LimitWrapUp } from "./agentLoopLimits.js";

/** Thrown when a run is already over its limit and must not call the model */
export class AgentLoopLimitError extends Error {
  readonly limit: AgentLoopLimitKind;

  constructor(wrapUp: LimitWrapUp) {
    super(`Agent loop stopped: ${wrapUp.description}`);
    this.name = "AgentLoopLimitError";
    this.limit = wrapUp.limit;
  }
}
