import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { parseMarkdownRule, RuleObject } from "@nextcli/config-yaml";

import { env } from "./env.js";
import { processRule } from "./hubLoader.js";
import { PermissionMode } from "./permissions/types.js";
import { findProjectAgentFile } from "./projectAgentFile.js";
import { serviceContainer } from "./services/ServiceContainer.js";
import { ConfigServiceState, SERVICE_NAMES } from "./services/types.js";

/**
 * Check if current directory is a git repository
 */
function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get git status
 */
function getGitStatus(): string {
  try {
    if (!isGitRepo()) {
      return "Not a git repository";
    }
    const result = execSync("git status --porcelain", {
      encoding: "utf-8",
      cwd: process.cwd(),
    });
    return result.trim() || "Working tree clean";
  } catch {
    return "Git status not available";
  }
}

const baseSystemMessage = `You are an agent in the NextCLI CLI. Given the user's prompt, you should use the tools available to you to answer the user's question.

Notes:
1. IMPORTANT: You should be concise, direct, and to the point, since your responses will be displayed on a command line interface.
2. When relevant, share file names and code snippets relevant to the query
Here is useful information about the environment you are running in:
<env>
Working directory: ${process.cwd()}
Is directory a git repo: ${isGitRepo()}
Platform: ${process.platform}
Today's date: ${new Date().toISOString().split("T")[0]}
</env>

As you answer the user's questions, you can use the following context:

<context name="gitStatus">This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.

${getGitStatus()}
</context>`;

interface LabeledRule {
  label: string;
  text: string;
}

async function getConfigYamlRules(): Promise<LabeledRule[]> {
  const configState = await serviceContainer.get<ConfigServiceState>(
    SERVICE_NAMES.CONFIG,
  );
  const rules = configState.config?.rules;
  if (!rules) {
    return [];
  }

  const labeled: LabeledRule[] = [];
  for (const rule of rules) {
    if (typeof rule === "string") {
      if (rule) {
        labeled.push({ label: "Config rule", text: rule });
      }
      continue;
    }
    if (!rule?.rule) {
      continue;
    }
    const name = "name" in rule && typeof rule.name === "string" ? rule.name : "";
    labeled.push({
      label: name || "Config rule",
      text: rule.rule,
    });
  }
  return labeled;
}

export interface SystemMessagePart {
  id: string;
  label: string;
  text: string;
}

function getRuleNameFromPath(filePath: string): string {
  const segments = filePath.split(/[/\\]/);
  const lastTwoParts = segments.slice(-2);
  return lastTwoParts.filter(Boolean).join("/").replace(/\.md$/, "");
}

/**
 * Scan the .continue/rules/ and .claude/rules/ directories for markdown rule files and return the rules with metadata that should be always-applied
 */
export function loadMarkdownRulesWithMetadata(): RuleObject[] {
  const cwd = process.cwd();
  const rulesDirs = [
    path.join(cwd, ".continue", "rules"),
    path.join(cwd, ".claude", "rules"),
    path.join(env.continueHome, "rules"),
  ];

  const rules: RuleObject[] = [];
  // A .claude/rules file may be a symlink to a .continue/rules one
  const loaded = new Set<string>();

  for (const dir of rulesDirs) {
    if (!fs.existsSync(dir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }

    for (const file of files) {
      if (!String(file).endsWith(".md")) continue;

      const filePath = path.join(dir, String(file));
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        const realPath = fs.realpathSync(filePath);
        if (loaded.has(realPath)) continue;
        loaded.add(realPath);
      } catch {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const { frontmatter, markdown } = parseMarkdownRule(content);

        if (frontmatter.invokable) continue;

        const isAlwaysApply =
          frontmatter.alwaysApply === true ||
          (frontmatter.alwaysApply === undefined &&
            !frontmatter.globs &&
            !frontmatter.regex);

        if (isAlwaysApply && markdown.trim()) {
          const ruleName =
            frontmatter.name || getRuleNameFromPath(String(file));
          rules.push({
            name: ruleName,
            rule: markdown,
            description: frontmatter.description,
            globs: frontmatter.globs,
            regex: frontmatter.regex,
            alwaysApply: true,
            sourceFile: filePath,
          });
        }
      } catch {
        // Skip files that can't be read or parsed
      }
    }
  }

  return rules;
}

export async function constructSystemMessageParts(
  mode: PermissionMode,
  additionalRules?: string[],
  format?: "json",
  headless?: boolean,
): Promise<SystemMessagePart[]> {
  let agentContent = "";
  let agentLabel = "";

  // No fallback to a lower-priority name: `/init` writes this file, so
  // loading another one would hide it.
  const agentFilePath = findProjectAgentFile(process.cwd());
  if (agentFilePath) {
    try {
      agentContent = fs.readFileSync(agentFilePath, "utf-8");
      agentLabel = path.basename(agentFilePath);
    } catch (error) {
      console.warn(
        `Warning: Could not read agent file ${agentFilePath}:`,
        error,
      );
    }
  }

  const labeledRules: LabeledRule[] = [];
  if (additionalRules && additionalRules.length > 0) {
    for (const ruleSpec of additionalRules) {
      try {
        labeledRules.push({
          label: ruleSpec,
          text: await processRule(ruleSpec),
        });
      } catch (error: any) {
        console.warn(
          `Warning: Failed to process rule "${ruleSpec}": ${error.message}`,
        );
      }
    }
  }

  labeledRules.push(...(await getConfigYamlRules()));

  const seen = new Set(labeledRules.map((rule) => rule.text));
  for (const rule of loadMarkdownRulesWithMetadata()) {
    if (!seen.has(rule.rule)) {
      labeledRules.push({ label: rule.name, text: rule.rule });
      seen.add(rule.rule);
    }
  }

  const parts: SystemMessagePart[] = [
    { id: "base", label: "Base instructions", text: baseSystemMessage },
  ];

  if (mode === "plan") {
    parts.push({
      id: "plan-mode",
      label: "Plan mode",
      text: '\n<context name="planMode">You are operating in _Plan Mode_, which means that your goal is to help the user investigate their ideas and develop a plan before taking action. You only have access to read-only tools and should not attempt to circumvent them to write / delete / create files. Ask the user to switch to agent mode if they want to make changes. For example, it is not acceptable to use the Bash tool to write to files.</context>\n',
    });
  } else if (!process.env.CONTINUE_CLI_DISABLE_COMMIT_SIGNATURE) {
    parts.push({
      id: "commit-signature",
      label: "Commit signature",
      text: `\n<context name="commitSignature">When creating commits using any CLI or tool, include the following in the commit message:
Generated with [NextCLI](https://nextcli.dev)

Co-Authored-By: NextCLI <noreply@nextcli.dev>
</context>\n`,
    });
  }

  if (headless) {
    parts.push({
      id: "headless",
      label: "Headless mode",
      text: `

IMPORTANT: You are running in headless mode. Provide ONLY your final answer to the user's question. Do not include explanations, reasoning, or additional commentary unless specifically requested. Be direct and concise.`,
    });
  }

  if (format === "json") {
    parts.push({
      id: "json",
      label: "JSON output",
      text: `

IMPORTANT: You are operating in JSON output mode. Your final response MUST be valid JSON that can be parsed by JSON.parse(). The JSON should contain properties relevant to answer the user's question. You don't need to include any general "response" or "answer" field. Do not include any text before or after the JSON - the entire response must be parseable JSON.

Example response format:
{
  "property": "value"
}`,
    });
  }

  const ruleBodies: SystemMessagePart[] = [];
  if (agentContent) {
    ruleBodies.push({
      id: "agent-file",
      label: agentLabel,
      text: `\n${agentContent}`,
    });
  }
  labeledRules.forEach((rule, index) => {
    const separator = ruleBodies.length === 0 ? "\n" : "\n\n";
    ruleBodies.push({
      id: `rule-${index}`,
      label: rule.label,
      text: `${separator}${rule.text}`,
    });
  });
  if (ruleBodies.length > 0) {
    ruleBodies[0] = {
      ...ruleBodies[0],
      text: `\n\n<context name="userRules">${ruleBodies[0].text}`,
    };
    const last = ruleBodies.length - 1;
    ruleBodies[last] = {
      ...ruleBodies[last],
      text: `${ruleBodies[last].text}\n</context>`,
    };
    parts.push(...ruleBodies);
  }

  return parts;
}

export async function constructSystemMessage(
  mode: PermissionMode,
  additionalRules?: string[],
  format?: "json",
  headless?: boolean,
): Promise<string> {
  const parts = await constructSystemMessageParts(
    mode,
    additionalRules,
    format,
    headless,
  );
  return parts.map((part) => part.text).join("");
}
