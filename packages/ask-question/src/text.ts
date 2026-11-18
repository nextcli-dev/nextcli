// Control characters except tab (\t) and line feed (\n), including C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Normalizes line endings, removes control characters and trims. Typed answers
 * go back to the model on every turn, so a stray carriage return would build
 * up turn after turn.
 */
export function cleanText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(CONTROL_CHARACTERS, "").trim();
}

/** cleanText, then all whitespace runs, line breaks included, become one space. */
export function cleanLine(value: string): string {
  return cleanText(value).replace(/\s+/g, " ");
}
