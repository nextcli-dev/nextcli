/**
 * Project agent files hold project guidance. The CLI (from its working
 * directory) and the VS Code extension (from the workspace root) load the
 * first one found, in this order, into every session.
 */
export const PROJECT_AGENT_FILE_NAMES = [
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "CODEX.md",
] as const;

/** The file `/init` creates when there is no project agent file. */
export const DEFAULT_PROJECT_AGENT_FILE = PROJECT_AGENT_FILE_NAMES[0];

/** Where the extension's old `/init` wrote project guidance. */
export const LEGACY_INIT_RULE_PATH = ".continue/rules/CONTINUE.md";

export interface InitPromptOptions {
  /** Path of the agent file `/init` should write, as the host's file tools accept it. */
  targetPath: string;
  /** Whether `targetPath` already exists (update) or not (create). */
  targetExists: boolean;
  /** Where the agent file is loaded from, e.g. "workspace root". */
  directoryLabel: string;
  /** Names of the host's tools for reading, creating and editing files. */
  tools: { read: string; create: string; edit: string };
  /** What the user should do when no file-writing tool is available. */
  noWriteToolsHint: string;
  /** Path of a leftover `.continue/rules/CONTINUE.md`, if any. */
  legacyRulePath?: string;
}

function targetStep(opts: InitPromptOptions): string {
  const { targetPath, tools, directoryLabel } = opts;
  if (opts.targetExists) {
    return `The agent file for this project is \`${targetPath}\`. Update it in place: read it with the \`${tools.read}\` tool, then change it with the \`${tools.edit}\` tool. Keep what is still accurate, fix what is stale, and fill in missing sections.

Do not use the \`${tools.create}\` tool on this file, do not create any other agent file, and do not rename it. Only this file is loaded, so guidance written anywhere else is ignored.`;
  }
  return `This project has no agent file yet. Create \`${targetPath}\` with the \`${tools.create}\` tool. That is the file loaded from the ${directoryLabel}; do not put it anywhere else, such as a parent directory or the git root.`;
}

function legacyStep(legacyRulePath: string): string {
  return `## Step 4: Retire the old guide

\`${legacyRulePath}\` was written by an older version of \`/init\` and is still loaded into every session next to the agent file. Read it, merge anything still accurate into the agent file, then delete it with your shell tool (for example \`rm "${legacyRulePath}"\`). If you can't run shell commands, tell the user to delete it.

`;
}

/**
 * Prompt for the `/init` slash command. The host resolves which file to write
 * and passes its own tool names, so the model doesn't have to guess.
 */
export function createInitPrompt(opts: InitPromptOptions): string {
  const { tools } = opts;
  const finishStep = opts.legacyRulePath ? 5 : 4;

  return `Set up the agent file for this project. Coding agents load it into every session, so it should help both agents and people work effectively with this codebase.

If you don't have the \`${tools.create}\` and \`${tools.edit}\` tools, stop and tell the user: ${opts.noWriteToolsHint}

## Step 1: The file to write

${targetStep(opts)}

## Step 2: Analyze the repository

Use your tools to understand the project structure. Read README files, package manifests (package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml and similar), build, test and lint configuration, and the main entry points.

## Step 3: Write the agent file

Use this structure, merging it with any existing content:

# Repository Overview

## Project Description
- What this project does
- Main purpose and goals
- Key technologies used

## Architecture Overview
- High-level architecture
- Main components and their relationships
- Data flow and system interactions

## Directory Structure
- Important directories and their purposes
- Key files and configuration
- Entry points and main modules

## Development Workflow
- How to build and run the project
- Testing approach and commands
- Development environment setup
- Lint and format commands

Keep the file concise but informative: it is added to every session's context. Prefer concrete commands and paths over general advice. If something can't be confirmed from the codebase, say it needs verification instead of guessing.

${opts.legacyRulePath ? legacyStep(opts.legacyRulePath) : ""}## Step ${finishStep}: Finish

Briefly summarize which file you created or updated and what changed. Remind the user to review it and commit it so the whole team shares it.`;
}
