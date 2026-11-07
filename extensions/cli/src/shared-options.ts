import { Command, InvalidArgumentError } from "commander";

/** Every effort level any model accepts; each model supports a subset */
export const EFFORT_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Parses --effort: a known level, in any case */
export function parseEffortOption(value: string): string {
  const level = value.trim().toLowerCase();
  if (!EFFORT_LEVELS.includes(level)) {
    throw new InvalidArgumentError(
      `Unknown effort "${value}". Use one of: ${EFFORT_LEVELS.join(", ")}.`,
    );
  }
  return level;
}

// Function to add common options to any command
export function addCommonOptions(command: Command): Command {
  return command
    .option(
      "--config <path>",
      "Configuration file for the assistant (can be a file path or hub slug)",
    )
    .option(
      "--org <slug>",
      "Organization slug to use for this session (supported only in headless mode)",
    )
    .option("--readonly", "Start in plan mode (read-only tools)")
    .option("--auto", "Start in auto mode (all tools allowed)")
    .option("--verbose", "Enable verbose logging")
    .option("--beta-status-tool", "Enable beta status tool")
    .option(
      "--rule <rule>",
      "Add a rule (can be a file path, hub slug, or string content). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--mcp <slug>",
      "Add an MCP server from the hub (slug in format 'owner/package'). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--model <slug>",
      "Add a model from the hub (slug in format 'owner/package'). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--prompt <prompt>",
      "Add to the initial user message (can be a file path, hub slug, or string content). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--allow <tool>",
      "Allow specified tool (overrides default policies). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--ask <tool>",
      "Ask for permission before using specified tool (overrides default policies). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--exclude <tool>",
      "Exclude specified tool from use (overrides default policies). Can be specified multiple times.",
      (value: string, previous: string[] | undefined) => {
        const array = Array.isArray(previous) ? previous : [];
        array.push(value);
        return array;
      },
      [] as string[],
    )
    .option(
      "--agent <slug>",
      "Load agent file from the hub (slug in format 'owner/package')",
    )
    .option(
      "--max-turns <n>",
      "Model calls allowed in one run; the last one gives a final answer without tools (default 100)",
    )
    .option(
      "--max-session-tokens <n>",
      "Tokens allowed in one run; near the limit the model gives a final answer (off by default)",
    )
    .option(
      "--max-cost <usd>",
      "US dollars allowed in one run; near the limit the model gives a final answer (off by default)",
    )
    .option(
      "--effort <level>",
      "Effort level for this run, for example low, medium or high (see the model menu)",
      parseEffortOption,
    );
}

// Function to merge parent options into subcommand options
export function mergeParentOptions(parentCommand: Command, options: any): any {
  const parentOpts = parentCommand.opts();
  const mergedOptions = { ...options };

  // List of options to inherit from parent if not present in subcommand
  const inheritableOptions = [
    "config",
    "org",
    "readonly",
    "auto",
    "tools",
    "verbose",
    "rule",
    "mcp",
    "model",
    "prompt",
    "allow",
    "ask",
    "exclude",
    "agent",
    "maxTurns",
    "maxSessionTokens",
    "maxCost",
    "effort",
  ];

  for (const optName of inheritableOptions) {
    if (
      parentOpts[optName] !== undefined &&
      mergedOptions[optName] === undefined
    ) {
      mergedOptions[optName] = parentOpts[optName];
    }
  }

  return mergedOptions;
}
