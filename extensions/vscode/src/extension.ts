/**
 * This is the entry point for the extension.
 */

import { setupCa } from "core/util/ca";
import * as vscode from "vscode";

export { default as buildTimestamp } from "./.buildTimestamp";

async function dynamicImportAndActivate(context: vscode.ExtensionContext) {
  await setupCa();
  const { activateExtension } = await import("./activation/activate");
  return await activateExtension(context);
}

/**
 * Registered before anything else loads, so "View Logs" works even when
 * activation fails (#12946)
 */
function registerViewLogsCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("continue.viewLogs", () => {
      outputChannel.show(true);
      void vscode.commands.executeCommand("workbench.action.toggleDevTools");
    }),
  );
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("NextCLI");
  context.subscriptions.push(outputChannel);
  registerViewLogsCommand(context, outputChannel);

  return dynamicImportAndActivate(context).catch((e) => {
    console.log("Error activating extension: ", e);
    const message = e instanceof Error ? e.message : String(e);
    outputChannel.appendLine(
      `Error activating NextCLI: ${(e instanceof Error && e.stack) || message}`,
    );
    vscode.window
      .showWarningMessage(
        `Error activating NextCLI: ${message}`,
        "View Logs",
        "Retry",
      )
      .then((selection) => {
        if (selection === "View Logs") {
          vscode.commands.executeCommand("continue.viewLogs");
        } else if (selection === "Retry") {
          // Reload VS Code window
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
  });
}

export function deactivate() {}
