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
 * the permission policies builds them again, and so does a change to the
 * MCP tools (a server that finishes connecting, drops or restarts). A
 * subagent's permissions are derived from the session's, so the session's
 * state is the key for both. A rebuild that gives the same bytes still
 * hits the provider's cache.
 *
 * A compaction's summary request passes the turn's system message, which
 * the summary was fit to, rather than reading the files again.
 */
export function turnPrefix(
  buildTools: () => Promise<ChatCompletionTool[]>,
  systemMessage?: string,
): () => Promise<Prefix> {
  let built:
    | (Prefix & { mode: PermissionMode; permissions: unknown; mcp: unknown })
    | undefined;
  return async () => {
    const { currentMode, permissions } = services.toolPermissions.getState();
    // Replaced by every MCP state update, kept by the state's shallow copy
    const mcp = services.mcp.getState().tools;
    if (
      built?.mode !== currentMode ||
      built.permissions !== permissions ||
      built.mcp !== mcp
    ) {
      built = {
        mode: currentMode,
        permissions,
        mcp,
        systemMessage:
          systemMessage ??
          (await services.systemMessage.getSystemMessage(currentMode)),
        tools: await buildTools(),
      };
    }
    return built;
  };
}
