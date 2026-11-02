import { getMarkdownLanguageTagForFile } from "core/util";
import { getUriPathBasename } from "core/util/uri";

/** Code block tags that say nothing about the target file's language */
const GENERIC_LANGUAGES = new Set(["", "text", "plaintext", "plain", "txt"]);

/** Tags that are interchangeable for the purpose of choosing a file */
const LANGUAGE_FAMILIES: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  js: "js",
  javascript: "js",
  jsx: "js",
  ts: "js",
  typescript: "js",
  tsx: "js",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  py: "python",
  python: "python",
  c: "c",
  h: "c",
  cpp: "c",
  "c++": "c",
};

function languageFamily(tag: string): string {
  const lower = tag.toLowerCase();
  return LANGUAGE_FAMILIES[lower] ?? lower;
}

function isInContinueDir(fileUri: string): boolean {
  return /(^|[\\/])\.continue[\\/]/.test(fileUri);
}

/**
 * When a code block has no file name, Apply falls back to the active editor.
 * Returns a warning when that fallback is likely wrong: the active file is a
 * NextCLI config file, or the code block's language doesn't match it (e.g. a
 * markdown block applied to config.yaml). Returns undefined when it's fine.
 */
export function getFallbackApplyWarning(
  language: string | null,
  fileUri: string,
): string | undefined {
  const basename = getUriPathBasename(fileUri);

  if (isInContinueDir(fileUri)) {
    return `This code block has no file name, so Apply would rewrite the active file "${basename}", which is a NextCLI config file. If Apply goes wrong, chat stops working until the config is fixed.`;
  }

  const blockLanguage = (language ?? "").trim();
  if (GENERIC_LANGUAGES.has(blockLanguage.toLowerCase())) {
    return undefined;
  }
  const fileLanguage = getMarkdownLanguageTagForFile(basename);
  if (!fileLanguage || basename.indexOf(".") === -1) {
    return undefined;
  }

  if (languageFamily(blockLanguage) !== languageFamily(fileLanguage)) {
    return `This ${blockLanguage} code block has no file name, so Apply would rewrite the active file "${basename}", which looks like a different language.`;
  }
  return undefined;
}
