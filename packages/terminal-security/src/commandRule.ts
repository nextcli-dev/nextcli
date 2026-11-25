/**
 * Whether a rule typed into a trusted-command list can be used: it starts
 * with a command name rather than a glob character (`git commit*` and `git*`,
 * not `*` or `?it`), and has no parenthesis, line break or surrounding space.
 * Kept free of imports so the VS Code webview can load it on its own
 * (`@continuedev/terminal-security/dist/commandRule.js`).
 */
export function isValidCommandRule(rule: string): boolean {
  return (
    rule.trim() === rule && /^[^\s*?]/.test(rule) && !/[()\r\n]/.test(rule)
  );
}
