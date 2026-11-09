import type { PermissionPolicy, ToolPermissionPolicy } from "./types.js";

/**
 * The argument a `Tool(glob)` rule is matched against, for each built-in
 * tool that takes one. toolPattern.test.ts checks each name against the
 * tool's parameters.
 */
export const PATTERN_ARGUMENT: Readonly<Record<string, string>> = {
  Bash: "command",
  Diff: "path",
  Edit: "file_path",
  Fetch: "url",
  List: "dirpath",
  MultiEdit: "file_path",
  Read: "filepath",
  Search: "pattern",
  Write: "filepath",
};

export class ToolPatternError extends Error {}

/**
 * Parses a rule written as `Tool`, a tool-name glob such as `github_*`, or
 * `Tool(glob)` for the argument in PATTERN_ARGUMENT. The same syntax is used
 * on the command line (--allow, --ask, --exclude) and in permissions.yaml.
 */
export function parseToolPattern(
  pattern: string,
  permission: PermissionPolicy,
): ToolPermissionPolicy {
  const trimmed = pattern.trim();
  const open = trimmed.indexOf("(");
  if (open === -1) {
    if (trimmed === "") {
      throw new ToolPatternError("Invalid tool pattern: empty");
    }
    return { tool: trimmed, permission };
  }

  const tool = trimmed.slice(0, open).trim();
  if (tool === "" || !trimmed.endsWith(")")) {
    throw new ToolPatternError(
      `Invalid tool pattern: ${pattern}. Write Tool or Tool(pattern).`,
    );
  }
  const glob = trimmed.slice(open + 1, -1).trim();
  if (glob === "") {
    return { tool, permission };
  }
  const argument = PATTERN_ARGUMENT[tool];
  if (!argument) {
    throw new ToolPatternError(
      `Invalid tool pattern: ${pattern}. ${tool} has no argument a pattern can match; write ${tool} alone.`,
    );
  }
  return { tool, permission, argumentMatches: { [argument]: glob } };
}

/** Rules from --exclude, --ask and --allow, in that order */
export function commandLineFlagsToPolicies(flags: {
  allow?: string[];
  ask?: string[];
  exclude?: string[];
}): ToolPermissionPolicy[] {
  return [
    ...(flags.exclude ?? []).map((p) => parseToolPattern(p, "exclude")),
    ...(flags.ask ?? []).map((p) => parseToolPattern(p, "ask")),
    ...(flags.allow ?? []).map((p) => parseToolPattern(p, "allow")),
  ];
}
