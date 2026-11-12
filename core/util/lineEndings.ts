/** Whether every line break is CRLF (a file with mixed line endings is not) */
export function usesCrlf(content: string): boolean {
  const lineBreaks = content.match(/\r?\n/g);
  return !!lineBreaks && lineBreaks.every((lineBreak) => lineBreak === "\r\n");
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
