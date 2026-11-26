import { looksLikeSecret } from "./secretEnv.js";

const REDACTED = "[redacted]";

/**
 * Credentials as they appear inside text, for redacting a transcript before
 * it is indexed or read back. SECRET_VALUE_GLOBS match a whole variable
 * value; these find the same kinds of tokens within prose, logs and code,
 * bounded by word edges and minimum lengths so ordinary words such as
 * "desk-lamp" stay.
 */
const SECRET_TEXT_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g, // JWT
  /\bsk-[\w-]{16,}/g, // OpenAI, Anthropic, DeepSeek and others
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_\w{20,}/g,
  /\bglpat-[\w-]{20,}/g, // GitLab
  /\bxox[abpr]-[\w-]{10,}/g, // Slack
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bAIza[\w-]{35}\b/g, // Google API key
  /\bhf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /\bnpm_[A-Za-z0-9]{20,}/g,
];

// A password in a URL: scheme://user:password@host. Up to the last @ before
// the path, since a password may itself contain @
const URL_PASSWORD = /(\b[a-z][\w+.-]*:\/\/[^\s:@/]+:)[^\s/]+@/gi;

// NAME=value, NAME: value, "name": "value". A quoted value may hold spaces
// (a passphrase); a bare one ends at a space or a separator
const ASSIGNMENT =
  /(["']?)\b([A-Za-z_][\w-]*)\1(\s*[=:]\s*)(?:"([^"\n]{6,512})"|'([^'\n]{6,512})'|([^\s"',;]{6,}))/g;

/** The text with every credential it recognises replaced by [redacted] */
export function redactSecretText(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  redacted = redacted.replace(URL_PASSWORD, `$1${REDACTED}@`);
  return redacted.replace(
    ASSIGNMENT,
    (match, nameQuote, name, separator, double, single, bare) => {
      const value: string = double ?? single ?? bare;
      const quote =
        double !== undefined ? '"' : single !== undefined ? "'" : "";
      // A path is redacted too: the shell filter keeps a path to a file
      // (a pointer to a credential), but text has no reason to stat it
      return looksLikeSecret(name.replace(/-/g, "_"), value)
        ? `${nameQuote}${name}${nameQuote}${separator}${quote}${REDACTED}${quote}`
        : match;
    },
  );
}
