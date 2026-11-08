import { ToolPermissionPolicy } from "./types.js";

/**
 * True when an --allow would turn the shell, Fetch, or every tool back on in
 * plan mode. A scoped pattern such as `Bash(git log*)` or `github_*` does not.
 * Exact names are not enough: `matchesToolPattern` treats `*` and `?` as
 * globs, so `Bash*`, `**` and `Bash(**)` match the same calls as `Bash` and `*`.
 */
export function planModeAllowReopensClosedTools(pattern: string): boolean {
  const scoped = pattern.match(/^(Bash|Fetch)\((.+)\)$/);
  if (scoped) {
    return globMatchesEveryCommand(scoped[2]);
  }
  return (
    patternMatchesToolName("Bash", pattern) ||
    patternMatchesToolName("Fetch", pattern)
  );
}

function patternMatchesToolName(toolName: string, pattern: string): boolean {
  if (pattern === "*" || pattern === toolName) {
    return true;
  }
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return false;
  }
  return globToRegExp(pattern).test(toolName);
}

/** A command glob such as `*` or `?*` that matches every real command. */
function globMatchesEveryCommand(glob: string): boolean {
  if (!glob.includes("*") && !glob.includes("?")) {
    return false;
  }
  const regex = globToRegExp(glob);
  return [
    "ls",
    "cp a.txt b.txt",
    "git log --output=out",
    "npm run build",
  ].every((command) => regex.test(command));
}

/** Same `*` and `?` rules as matchesToolPattern. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

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
