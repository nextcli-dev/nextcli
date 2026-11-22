import type { Usage } from "core/index.js";

let lastResponseUsage: Usage | undefined;

/** The provider usage of the latest model response, not the session total. */
export function rememberResponseUsage(usage: Usage): void {
  lastResponseUsage = usage;
}

export function getLastResponseUsage(): Usage | undefined {
  return lastResponseUsage;
}
