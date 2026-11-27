import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";

import type { PermissionMode } from "../permissions/types.js";
import { services } from "../services/index.js";

interface Prefix {
  systemMessage: string;
  tools: ChatCompletionTool[];
}

/**
 * The system message and tools of one user turn's requests. Built once per
 * turn, so each request starts with the bytes the previous request cached
 * at the provider; a file the agent edits mid-turn (AGENTS.md, a rule or
 * skill) applies from the next user message. A mode switch or a change to
 * the permission policies builds them again. A subagent's permissions are
 * derived from the session's, so the session's state is the key for both.
 */
export function turnPrefix(
  build: (mode: PermissionMode) => Promise<Prefix>,
): () => Promise<Prefix> {
  let built:
    | (Prefix & { mode: PermissionMode; permissions: unknown })
    | undefined;
  return async () => {
    const { currentMode, permissions } = services.toolPermissions.getState();
    if (built?.mode !== currentMode || built.permissions !== permissions) {
      built = { mode: currentMode, permissions, ...(await build(currentMode)) };
    }
    return built;
  };
}
