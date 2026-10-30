/**
 * Continue team privileges are disabled in NextCLI.
 * The name is kept so existing call sites still compile.
 */
export function isContinueTeamMember(_email?: string): boolean {
  return false;
}
