import {
  ConfigValidationError,
  markdownToRule,
  parseMarkdownRule,
} from "@nextcli/config-yaml";
import { IDE, RuleWithSource } from "../..";
import { walkDirs } from "../../indexing/walkDir";
import { RULES_MARKDOWN_FILENAME } from "../../llm/rules/constants";
import {
  findUriInDirs,
  getLastNPathParts,
  getUriPathBasename,
  getUriPathParts,
} from "../../util/uri";

/**
 * Labels each workspace root by the shortest trailing part of its path that no
 * other root ends with: /a/nextcli and /b/nextcli become "a/nextcli" and
 * "b/nextcli", while /work/gui alone stays "gui".
 */
function getWorkspaceRootLabels(workspaceDirs: string[]): Map<string, string> {
  const roots = [...new Set(workspaceDirs)].map((dir) => ({
    dir,
    parts: getUriPathParts(dir).map(decodeURIComponent),
  }));
  const suffix = (parts: string[], n: number) => parts.slice(-n).join("/");
  const labels = new Map<string, string>();
  for (const root of roots) {
    let n = Math.min(1, root.parts.length);
    while (
      n < root.parts.length &&
      roots.some(
        (other) =>
          other !== root && suffix(other.parts, n) === suffix(root.parts, n),
      )
    ) {
      n++;
    }
    labels.set(root.dir, suffix(root.parts, n));
  }
  return labels;
}

/**
 * Builds a rule from a colocated rules.md file. Without a frontmatter `name`,
 * the rule is named by its path from the workspace root: the old name (last two
 * path segments) collides for e.g. packages/a/src/rules.md and
 * packages/b/src/rules.md, or for the same file in two checkouts of a repo.
 * In a multi-root workspace the name starts with the root's label, as roots
 * can share relative paths.
 *
 * Rule on/off settings are keyed by name, so a renamed rule carries its old
 * name in `legacyName` for the GUI to move the setting over.
 */
function codebaseRuleFromFile(
  content: string,
  fileUri: string,
  workspaceDirs: string[],
): RuleWithSource | undefined {
  // The deepest root that holds the file, whatever the order of the roots, so
  // the name and glob base don't depend on it when roots are nested.
  const rootsDeepestFirst = [...workspaceDirs].sort(
    (a, b) => getUriPathParts(b).length - getUriPathParts(a).length,
  );
  const { relativePathOrBasename, foundInDir, uri } = findUriInDirs(
    fileUri,
    rootsDeepestFirst,
  );
  if (!foundInDir) {
    return undefined;
  }
  const lastSlash = relativePathOrBasename.lastIndexOf("/");
  // A rules.md at the root gets no glob base: "" would turn its globs into
  // "/**/*", which only matches from the filesystem root.
  const parentDir =
    lastSlash === -1
      ? undefined
      : relativePathOrBasename.substring(0, lastSlash);
  const rule = markdownToRule(
    content,
    { uriType: "file", fileUri: uri },
    parentDir,
  );
  const ruleWithSource: RuleWithSource = {
    ...rule,
    source: "colocated-markdown",
    sourceFile: fileUri,
  };
  if (parseMarkdownRule(content).frontmatter.name) {
    return ruleWithSource;
  }
  const rootLabel =
    workspaceDirs.length > 1
      ? getWorkspaceRootLabels(workspaceDirs).get(foundInDir)
      : undefined;
  const name = rootLabel
    ? `${rootLabel}/${relativePathOrBasename}`
    : relativePathOrBasename;
  const legacyName = getLastNPathParts(fileUri, 2);
  return {
    ...ruleWithSource,
    name,
    ...(legacyName !== name && { legacyName }),
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
    // Nested workspace roots list the same file once per root
    const rulesMdFiles = [
      ...new Set(
        allFiles.filter(
          (file) => getUriPathBasename(file) === RULES_MARKDOWN_FILENAME,
        ),
      ),
    ];

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
