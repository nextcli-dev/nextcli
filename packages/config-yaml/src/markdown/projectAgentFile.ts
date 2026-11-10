/**
 * Project agent files hold project guidance at the workspace root. The CLI and
 * the VS Code extension load the first one found, in this order, into every
 * session.
 */
export const PROJECT_AGENT_FILE_NAMES = [
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "CODEX.md",
] as const;

/** The file `/init` creates when the workspace has no project agent file. */
export const DEFAULT_PROJECT_AGENT_FILE = PROJECT_AGENT_FILE_NAMES[0];

/**
 * Prompt for the `/init` slash command. It names no tools so it works with
 * both the CLI and the IDE tool sets.
 */
export function createInitPrompt(): string {
  const fileList = PROJECT_AGENT_FILE_NAMES.map((name) => `\`${name}\``).join(
    ", ",
  );

  return `Set up the project agent file for this repository. Coding agents load it into every session, so it should help both agents and people work effectively with this codebase.

## Step 1: Find the existing agent file

Check the workspace root for these files, in this order: ${fileList}.

- If one exists, that is the file to work on. Read it first, then update it in place: keep what is still accurate, fix what is stale, and fill in missing sections. Do not create another agent file and do not rename the existing one.
- If none exists, create \`${DEFAULT_PROJECT_AGENT_FILE}\` at the workspace root.

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

## Step 4: Finish

Briefly summarize which file you created or updated and what changed. Remind the user to review it and commit it so the whole team shares it.`;
}
