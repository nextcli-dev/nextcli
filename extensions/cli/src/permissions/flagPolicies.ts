import { ToolPermissionPolicy } from "./types.js";

/**
 * Converts command line flags to policies
 */
export function commandLineFlagsToPolicies(flags: {
  allow?: string[];
  ask?: string[];
  exclude?: string[];
}): ToolPermissionPolicy[] {
  const policies: ToolPermissionPolicy[] = [];

  // Order matters for CLI flags too
  if (flags.exclude) {
    for (const tool of flags.exclude) {
      const normalizedName = tool;
      policies.push({ tool: normalizedName, permission: "exclude" });
    }
  }

  if (flags.ask) {
    for (const tool of flags.ask) {
      const normalizedName = tool;
      policies.push({ tool: normalizedName, permission: "ask" });
    }
  }

  if (flags.allow) {
    for (const tool of flags.allow) {
      const normalizedName = tool;
      policies.push({ tool: normalizedName, permission: "allow" });
    }
  }

  return policies;
}
