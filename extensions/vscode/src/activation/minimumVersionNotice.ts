import { GlobalContext } from "core/util/GlobalContext";
import * as vscode from "vscode";

/**
 * Advance notice of the minimum VS Code version. Starting with extension
 * version 1.8 the extension needs VS Code 1.101 or newer (the first release
 * with Node.js 22). Older VS Code keeps working with 1.6.x, which is the last
 * compatible version, and the Marketplace keeps offering it.
 *
 * The notice is shown once, and only to users on an older VS Code.
 */
export const UPCOMING_MINIMUM_VSCODE_VERSION = "1.101.0";
export const MINIMUM_VERSION_DOCS_URL =
  "https://docs.nextcli.dev/ide-extensions/install#requirements";

/** True if `version` ("1.95.0", "1.95.0-insider") is older than `minimum`. */
export function isOlderThan(version: string, minimum: string): boolean {
  const parse = (v: string) => {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
    return match ? [match[1], match[2], match[3] ?? "0"].map(Number) : null;
  };
  const current = parse(version);
  const required = parse(minimum);
  if (!current || !required) {
    // An unrecognized version string is not a reason to show a notice.
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (current[i] !== required[i]) {
      return current[i] < required[i];
    }
  }
  return false;
}

export function showMinimumVersionNotice(
  globalContext: GlobalContext,
  vscodeVersion: string = vscode.version,
): void {
  if (
    !isOlderThan(vscodeVersion, UPCOMING_MINIMUM_VSCODE_VERSION) ||
    globalContext.get("hasShownMinimumVsCodeVersionNotice")
  ) {
    return;
  }
  globalContext.update("hasShownMinimumVsCodeVersionNotice", true);

  const minimum = UPCOMING_MINIMUM_VSCODE_VERSION.replace(/\.0$/, "");
  void vscode.window
    .showInformationMessage(
      `NextCLI 1.8 and later will need VS Code ${minimum} or newer. You are on VS Code ${vscodeVersion}, so you will stay on NextCLI 1.6.x, which keeps working. Update VS Code to receive new NextCLI releases.`,
      "Learn more",
    )
    .then((selection) => {
      if (selection === "Learn more") {
        void vscode.env.openExternal(
          vscode.Uri.parse(MINIMUM_VERSION_DOCS_URL),
        );
      }
    });
}
