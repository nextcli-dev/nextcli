import { minimatch } from "minimatch";
import {
  ContextItemWithId,
  RuleMetadata,
  RuleWithSource,
  ToolResultChatMessage,
  UserChatMessage,
} from "../..";
import { renderChatMessage } from "../../util/messageContent";
import { getCleanUriPath } from "../../util/uri";
import { extractContentFromCodeBlock } from "../utils/extractContentFromCodeBlocks";
import { extractPathsFromCodeBlocks } from "../utils/extractPathsFromCodeBlocks";
import { RulePolicies } from "./types";

/**
 * Checks if a path matches any of the provided globs
 * Supports negative patterns with ! prefix
 */
const matchesGlobs = (
  filePath: string,
  globs: string | string[] | undefined,
): boolean => {
  if (!globs) return true;

  // Handle single string glob
  if (typeof globs === "string") {
    if (globs.startsWith("!")) {
      // Negative pattern - return false if it matches
      return !minimatch(filePath, globs.substring(1));
    }
    return minimatch(filePath, globs);
  }

  // Handle array of globs
  if (Array.isArray(globs)) {
    // Split into positive and negative patterns
    const positivePatterns = globs.filter((g) => !g.startsWith("!"));
    const negativePatterns = globs
      .filter((g) => g.startsWith("!"))
      .map((g) => g.substring(1)); // Remove ! prefix

    // If there are no positive patterns, the file matches unless it matches a negative pattern
    if (positivePatterns.length === 0) {
      return !negativePatterns.some((pattern) => minimatch(filePath, pattern));
    }

    // File must match at least one positive pattern AND not match any negative patterns
    return (
      positivePatterns.some((pattern) => minimatch(filePath, pattern)) &&
      !negativePatterns.some((pattern) => minimatch(filePath, pattern))
    );
  }

  return false;
};

/**
 * Checks if file content matches any of the provided regex regex
 *
 * @param fileContent - The content of the file to check
 * @param regex - A single regex pattern string or array of regex pattern strings
 * @returns true if the content matches any pattern (or if no regex is provided), false otherwise
 */
const contentMatchesRegex = (
  fileContent: string,
  regex: string | string[],
): boolean => {
  // Handle single string pattern
  if (typeof regex === "string") {
    try {
      const expression = new RegExp(regex);
      return expression.test(fileContent);
    } catch (e) {
      console.error(`Invalid regex pattern: ${regex}`, e);
      return false;
    }
  }

  // Handle array of regex
  if (Array.isArray(regex)) {
    if (regex.length === 0) return true;

    // Content must match at least one pattern
    return regex.some((pattern) => {
      try {
        const regex = new RegExp(pattern);
        return regex.test(fileContent);
      } catch (e) {
        console.error(`Invalid regex pattern: ${pattern}`, e);
        return false;
      }
    });
  }

  return false;
};

/**
 * Determines if a file path is within a specific directory or its subdirectories
 *
 * @param filePath - The file path to check
 * @param directoryPath - The directory path to check against
 * @returns true if the file is in the directory or subdirectory, false otherwise
 */
const isFileInDirectory = (
  filePath: string,
  directoryPath: string,
): boolean => {
  // Normalize paths for consistent comparison
  let normalizedFilePath = filePath.replace(/\\/g, "/");
  let normalizedDirPath = directoryPath.replace(/\\/g, "/");

  // Strip the file:// protocol if present
  normalizedFilePath = normalizedFilePath.replace(/^file:\/\//, "");
  normalizedDirPath = normalizedDirPath.replace(/^file:\/\//, "");

  // Extract the last parts of the paths for comparison
  // This allows matching relative paths with absolute paths
  // e.g., "nested-folder/file.py" should match "/path/to/nested-folder/"
  const dirPathParts = normalizedDirPath.split("/");

  // Get the directory name (last part of the directory path)
  const dirName = dirPathParts[dirPathParts.length - 1];

  // Check if the file path contains this directory followed by a slash
  // This is a simple check to see if the file might be in this directory
  const containsDir = normalizedFilePath.includes(`${dirName}/`);

  return containsDir;
};

/**
 * Checks if a rule is a root-level rule (.continue directory, .claude/rules
 * or no file path)
 */
const isRootLevelRule = (rule: RuleWithSource): boolean => {
  // sourceFile path is absolute - hence we need to check for it in between
  return (
    !rule.sourceFile ||
    rule.sourceFile.includes(".continue/") ||
    rule.sourceFile.includes(".claude/rules/")
  );
};

/**
 * Determines if a rule should be considered global and always applied
 * This includes rules with alwaysApply: true OR root-level rules with no globs
 */
const isGlobalRule = (rule: RuleWithSource): boolean => {
  // Rules with alwaysApply: true are always global
  if (rule.alwaysApply === true) {
    return true;
  }

  // Root-level rules with no globs or regex are implicitly global
  if (
    isRootLevelRule(rule) &&
    !rule.globs &&
    !rule.regex &&
    rule.alwaysApply !== false
  ) {
    return true;
  }

  return false;
};

/**
 * A file's path relative to the project a root-level rule belongs to: the
 * part of the rule's sourceFile before /.claude/rules/ or /.continue/. Rules
 * write project-relative globs (src/**), while files in the editor's context
 * come as absolute URIs. Relative paths, and files outside that project,
 * are returned as they are.
 */
const projectRelativePath = (
  rule: RuleWithSource,
  filePath: string,
): string => {
  const source = rule.sourceFile;
  if (!source) {
    return filePath;
  }
  const marker = [
    source.indexOf("/.claude/rules/"),
    source.indexOf("/.continue/"),
  ]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (marker === undefined) {
    return filePath;
  }
  const root = source.slice(0, marker + 1);
  if (!filePath.startsWith(root)) {
    return filePath;
  }
  const relative = filePath.slice(root.length);
  try {
    return decodeURIComponent(relative);
  } catch {
    return relative;
  }
};

const checkGlobsAndRegex = ({
  rule,
  filePaths,
  fileContents,
}: {
  rule: RuleWithSource;
  filePaths: string[];
  fileContents: Record<string, string>;
}) => {
  const matchingFiles = rule.globs
    ? filePaths.filter((filePath) =>
        matchesGlobs(projectRelativePath(rule, filePath), rule.globs),
      )
    : filePaths;

  // If no files match the globs, don't apply the rule
  if (matchingFiles.length === 0) {
    return false;
  }

  // Now check for pattern matches in file contents if regex are specified
  if (rule.regex) {
    // Check if any of the matching files also match the content regex
    return matchingFiles.some((filePath) => {
      const content = fileContents[filePath];
      // If we don't have the content, we can't check regex
      if (!content) return false;
      return contentMatchesRegex(content, rule.regex!);
    });
  }

  // If we have no regex or if we couldn't check regex (no content),
  // just go with the glob matches
  return matchingFiles.length > 0;
};

/**
 * Determines if a rule should be applied based on its properties and file matching
 *
 * @param rule - The rule to check
 * @param filePaths - Array of file paths to check against the rule's globs
 * @param fileContents - Map of file paths to their contents for pattern matching
 * @param rulePolicies - Optional policies that can override normal rule behavior
 * @returns true if the rule should be applied, false otherwise
 */
export const shouldApplyRule = (
  rule: RuleWithSource,
  filePaths: string[],
  rulePolicies: RulePolicies = {},
  fileContents: Record<string, string> = {},
): boolean => {
  const policy = rulePolicies[rule.name || ""];

  // Never apply if policy is "off"
  if (policy === "off") {
    return false;
  }

  // If it's a global rule, always apply it regardless of file paths
  if (isGlobalRule(rule)) {
    return true;
  }

  // If there are no file paths to check and we've made it here:
  // - We've already handled global rules above
  // - Don't apply other rules since we have no files to match against
  if (filePaths.length === 0) {
    return false;
  }

  // Check if this is a root-level rule (in .continue directory or no file path)
  const isRootRule = isRootLevelRule(rule);

  // For non-root rules, we need to check if any files are in the rule's directory
  if (!isRootRule && rule.sourceFile) {
    const ruleDirectory = getCleanUriPath(rule.sourceFile);
    const lastSlashIndex = ruleDirectory.lastIndexOf("/");
    const ruleDirPath =
      lastSlashIndex === -1 ? "" : ruleDirectory.substring(0, lastSlashIndex);

    // Filter to only files in this directory or its subdirectories
    const filesInRuleDirectory = filePaths.filter((filePath) =>
      isFileInDirectory(filePath, ruleDirPath),
    );

    return checkGlobsAndRegex({
      filePaths: filesInRuleDirectory,
      fileContents,
      rule,
    });
  }

  // If alwaysApply is explicitly false, we need to check globs and/or regex
  if (
    rule.alwaysApply === false &&
    rule.globs === undefined &&
    rule.regex === undefined
  ) {
    return false;
  }

  return checkGlobsAndRegex({
    filePaths,
    fileContents,
    rule,
  });
};

type RuleMessage = UserChatMessage | ToolResultChatMessage;
type RuleMessages = RuleMessage | RuleMessage[] | undefined;

/**
 * Filters rules that apply to the given message and/or context items
 *
 * @param userMessage - The user or tool messages to check for file paths in
 * code blocks. Chat passes every one since the last user message, so the
 * rules only grow during a turn and the system message stays cached.
 * @param rules - The list of rules to filter
 * @param contextItems - Context items to check for file paths
 * @returns List of applicable rules
 */
export const getApplicableRules = (
  userMessage: RuleMessages,
  rules: RuleWithSource[],
  contextItems: ContextItemWithId[],
  rulePolicies: RulePolicies = {},
): RuleWithSource[] => {
  // Get file paths from the messages and context for rule matching
  const messageContents = [userMessage ?? []].flat().map(renderChatMessage);
  const filePathsFromMessage = messageContents.flatMap(
    extractPathsFromCodeBlocks,
  );

  // Extract file paths from context items
  const filePathsFromContextItems = contextItems
    .filter((item) => item.uri?.type === "file" && item.uri?.value)
    .map((item) => item.uri!.value);

  // Combine file paths from both sources
  const allFilePaths = [...filePathsFromMessage, ...filePathsFromContextItems];

  // Create a map of file paths to their contents for pattern matching
  const fileContents: Record<string, string> = {};

  // Extract contents from context items with file URIs
  contextItems.forEach((item) => {
    if (item.uri?.type === "file" && item.uri?.value) {
      fileContents[item.uri.value] = item.content;
    }
  });

  // Extract contents from code blocks in the messages for paths that don't have content yet
  for (const messageContent of messageContents) {
    filePathsFromMessage.forEach((path) => {
      // Only extract content if we don't already have it
      if (!fileContents[path]) {
        const blockContent = extractContentFromCodeBlock(messageContent, path);
        if (blockContent) {
          fileContents[path] = blockContent;
        }
      }
    });
  }

  // Apply shouldApplyRule to all rules - this will handle global rules, rule policies,
  // and path matching in a consistent way
  const applicableRules = rules.filter((rule) =>
    shouldApplyRule(rule, allFilePaths, rulePolicies, fileContents),
  );

  return applicableRules;
};

export function getRuleId(rule: RuleMetadata): string {
  return rule.slug ?? rule.sourceFile ?? rule.name ?? rule.source;
}

export const getSystemMessageWithRules = ({
  baseSystemMessage,
  userMessage,
  availableRules,
  contextItems,
  rulePolicies = {},
}: {
  baseSystemMessage?: string;
  userMessage: RuleMessages;
  availableRules: RuleWithSource[];
  contextItems: ContextItemWithId[];
  rulePolicies?: RulePolicies;
}): {
  systemMessage: string;
  appliedRules: RuleMetadata[];
  ruleParts: { label: string; chars: number }[];
} => {
  const appliedRules = getApplicableRules(
    userMessage,
    availableRules,
    contextItems,
    rulePolicies,
  );
  let systemMessage = baseSystemMessage ?? "";
  const ruleParts: { label: string; chars: number }[] = [];

  for (const rule of appliedRules) {
    const separator = systemMessage ? "\n\n" : "";
    const piece = `${separator}${rule.rule}`;
    ruleParts.push({
      label: rule.name ?? getRuleId(rule),
      chars: piece.length,
    });
    systemMessage += piece;
  }

  const ruleMetadata = appliedRules.map(({ rule, ...rest }) => rest);

  return {
    systemMessage,
    appliedRules: ruleMetadata,
    ruleParts,
  };
};
