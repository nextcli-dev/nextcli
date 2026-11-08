import { ToolPermissionPolicy } from "./types.js";

export function commandLineFlagsToPolicies(flags: {
  allow?: string[];
  ask?: string[];
  exclude?: string[];
}): ToolPermissionPolicy[] {
  const policies: ToolPermissionPolicy[] = [];

  // Order matters for CLI flags too
  if (flags.exclude) {
    for (const tool of flags.exclude) {
      policies.push({ tool, permission: "exclude" });
    }
  }

  if (flags.ask) {
    for (const tool of flags.ask) {
      policies.push({ tool, permission: "ask" });
    }
  }

  if (flags.allow) {
    for (const tool of flags.allow) {
      policies.push({ tool, permission: "allow" });
    }
  }

  return policies;
}
