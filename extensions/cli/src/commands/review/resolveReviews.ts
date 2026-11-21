import * as fs from "fs";
import * as path from "path";

import { parseMarkdownRule } from "@nextcli/config-yaml";
import { minimatch } from "minimatch";

export interface ResolvedReview {
  /** Display name for the review */
  name: string;
  /** Hub slug (org/agent) or local file path */
  source: string;
  /** 'hub' | 'local' */
  sourceType: "hub" | "local";
  /** A local check's `paths`: it runs only when a changed file matches one */
  paths?: string[];
}

/**
 * Whether a changed file matches a check's `paths` pattern, as nextcli-checks
 * decides it (`path_matches` in scripts/checks.py): a relative pattern also
 * matches at any depth
 */
function pathMatches(file: string, pattern: string): boolean {
  const posix = file.replace(/\\/g, "/");
  return (
    minimatch(posix, pattern, { dot: true }) ||
    minimatch(posix, `**/${pattern}`, { dot: true })
  );
}

/**
 * The reviews that apply to these changed files: a check with `paths` runs
 * only when one of them matches, like in nextcli-checks; others always run
 */
export function applicableReviews(
  reviews: ResolvedReview[],
  changedFiles: string[],
): ResolvedReview[] {
  return reviews.filter(
    (review) =>
      !review.paths ||
      changedFiles.some((file) =>
        review.paths!.some((pattern) => pathMatches(file, pattern)),
      ),
  );
}

/** A local check's frontmatter; none when the file can't be read */
function readFrontmatter(filePath: string): {
  name?: string;
  paths?: string[];
} {
  try {
    const { frontmatter } = parseMarkdownRule(
      fs.readFileSync(filePath, "utf-8"),
    );
    // parseMarkdownRule reads `paths` into `globs`
    const globs = frontmatter.globs;
    return {
      name: frontmatter.name,
      ...(globs !== undefined && { paths: [globs].flat() }),
    };
  } catch {
    return {};
  }
}

/**
 * Determine which reviews to run, using two sources in order:
 * 1. CLI --agent flags (highest priority)
 * 2. Local .continue/agents/*.md, .continue/checks/*.md and .claude/checks/*.md (fallback)
 */
export async function resolveReviews(
  agentFlags?: string[],
): Promise<ResolvedReview[]> {
  // Source 1: CLI --agent flags
  if (agentFlags && agentFlags.length > 0) {
    return agentFlags.map((agent) => ({
      name: agentDisplayName(agent),
      source: agent,
      sourceType: isLocalPath(agent) ? "local" : "hub",
    }));
  }

  // Hub resolution was removed: resolveFromHub returns none
  const hubReviews = await resolveFromHub();
  if (hubReviews.length > 0) {
    return hubReviews;
  }

  // Source 2: Local .continue/agents/*.md, .continue/checks/*.md and .claude/checks/*.md
  const localReviews = resolveFromLocal();
  if (localReviews.length > 0) {
    return localReviews;
  }

  return [];
}

/**
 * Hub review resolution has been removed.
 */
async function resolveFromHub(): Promise<ResolvedReview[]> {
  return [];
}

/**
 * Resolve reviews from local .continue/agents/*.md, .continue/checks/*.md and
 * .claude/checks/*.md files. When a filename is in more than one directory, the
 * first directory in that order wins. .claude/agents is not read: Claude Code
 * keeps subagents there, not reviews.
 */
function resolveFromLocal(): ResolvedReview[] {
  const cwd = process.cwd();
  const dirs = [
    path.join(cwd, ".continue", "agents"),
    path.join(cwd, ".continue", "checks"),
    path.join(cwd, ".claude", "checks"),
  ];

  const seen = new Set<string>();
  const results: ResolvedReview[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        if (!seen.has(file)) {
          seen.add(file);
          const source = path.join(dir, file);
          const { name, paths } = readFrontmatter(source);
          results.push({
            name: name ?? path.basename(file, ".md").replace(/[-_]/g, " "),
            source,
            sourceType: "local" as const,
            ...(paths && { paths }),
          });
        }
      }
    } catch {
      // Directory read failed, skip
    }
  }

  return results;
}

function isLocalPath(agent: string): boolean {
  return (
    agent.startsWith(".") ||
    agent.startsWith("/") ||
    agent.startsWith("~") ||
    agent.endsWith(".md") ||
    agent.endsWith(".yaml") ||
    agent.endsWith(".yml") ||
    // Windows absolute path (C:\...)
    /^[A-Za-z]:[/\\]/.test(agent)
  );
}

function agentDisplayName(agent: string): string {
  if (isLocalPath(agent)) {
    return path.basename(agent, path.extname(agent)).replace(/[-_]/g, " ");
  }
  // Hub slug: "org/agent-name" -> "agent-name" -> "agent name"
  const parts = agent.split("/");
  return (parts[parts.length - 1] || agent).replace(/[-_]/g, " ");
}
