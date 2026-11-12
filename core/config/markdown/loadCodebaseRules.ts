import {
  ConfigValidationError,
  markdownToRule,
  parseMarkdownRule,
} from "@nextcli/config-yaml";
import { IDE, RuleWithSource } from "../..";
import { walkDirs } from "../../indexing/walkDir";
import { RULES_MARKDOWN_FILENAME } from "../../llm/rules/constants";
import { findUriInDirs, getUriPathBasename } from "../../util/uri";

/**
 * Builds a rule from a colocated rules.md file. Without a frontmatter `name`,
 * the rule is named by its workspace-relative path: the default name (last two
 * path segments) collides for e.g. packages/a/src/rules.md and
 * packages/b/src/rules.md, or for the same file in two checkouts of a repo.
 */
function codebaseRuleFromFile(
  content: string,
  fileUri: string,
  workspaceDirs: string[],
): RuleWithSource | undefined {
  const { relativePathOrBasename, foundInDir, uri } = findUriInDirs(
    fileUri,
    workspaceDirs,
  );
  if (!foundInDir) {
    return undefined;
  }
  const parentDir = relativePathOrBasename.substring(
    0,
    relativePathOrBasename.lastIndexOf("/"),
  );
  const rule = markdownToRule(
    content,
    { uriType: "file", fileUri: uri },
    parentDir,
  );
  const hasFrontmatterName = Boolean(
    parseMarkdownRule(content).frontmatter.name,
  );
  // In a multi-root workspace, roots can share relative paths, so prefix the
  // root folder name.
  const name = hasFrontmatterName
    ? rule.name
    : workspaceDirs.length > 1
      ? `${getUriPathBasename(foundInDir)}/${relativePathOrBasename}`
      : relativePathOrBasename;
  return {
    ...rule,
    name,
    source: "colocated-markdown",
    sourceFile: fileUri,
  };
}

export class CodebaseRulesCache {
  private static instance: CodebaseRulesCache | null = null;
  private constructor() {}

  public static getInstance(): CodebaseRulesCache {
    if (CodebaseRulesCache.instance === null) {
      CodebaseRulesCache.instance = new CodebaseRulesCache();
    }
    return CodebaseRulesCache.instance;
  }
  rules: RuleWithSource[] = [];
  errors: ConfigValidationError[] = [];
  async refresh(ide: IDE) {
    const { rules, errors } = await loadCodebaseRules(ide);
    this.rules = rules;
    this.errors = errors;
  }
  async update(ide: IDE, uri: string) {
    const content = await ide.readFile(uri);
    const ruleWithSource = codebaseRuleFromFile(
      content,
      uri,
      await ide.getWorkspaceDirs(),
    );
    if (!ruleWithSource) {
      console.warn(
        `Failed to load codebase rule ${uri}: URI not found in workspace`,
      );
      return;
    }
    const matchIdx = this.rules.findIndex((r) => r.sourceFile === uri);
    if (matchIdx === -1) {
      this.rules.push(ruleWithSource);
    } else {
      this.rules[matchIdx] = ruleWithSource;
    }
  }
  remove(uri: string) {
    this.rules = this.rules.filter((r) => r.sourceFile !== uri);
  }
}

/**
 * Loads rules from rules.md files colocated in the codebase
 */
export async function loadCodebaseRules(ide: IDE): Promise<{
  rules: RuleWithSource[];
  errors: ConfigValidationError[];
}> {
  const errors: ConfigValidationError[] = [];
  const rules: RuleWithSource[] = [];

  try {
    // Get all files from the workspace
    const allFiles = await walkDirs(ide);

    // Filter to just rules.md files
    const rulesMdFiles = allFiles.filter((file) => {
      const filename = getUriPathBasename(file);
      return filename === RULES_MARKDOWN_FILENAME;
    });

    const workspaceDirs = await ide.getWorkspaceDirs();

    // Process each rules.md file
    for (const filePath of rulesMdFiles) {
      try {
        const content = await ide.readFile(filePath);
        const rule = codebaseRuleFromFile(content, filePath, workspaceDirs);
        if (rule) {
          rules.push(rule);
        } else {
          console.warn(
            `Failed to load codebase rule ${filePath}: URI not found in workspace dirs`,
          );
        }
      } catch (e) {
        errors.push({
          fatal: false,
          message: `Failed to parse colocated rule file ${filePath}: ${e instanceof Error ? e.message : e}`,
        });
      }
    }
  } catch (e) {
    errors.push({
      fatal: false,
      message: `Error loading colocated rule files: ${e instanceof Error ? e.message : e}`,
    });
  }

  return { rules, errors };
}
