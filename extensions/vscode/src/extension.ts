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

// Holds the activation error. Created only when activation fails, so a healthy
// install doesn't get an empty output channel.
let activationErrorChannel: vscode.OutputChannel | undefined;

/**
 * Registered before anything else loads, so "View Logs" works even when
 * activation fails (#12946). It toggles DevTools, as the webview expects, and
 * also shows the activation error if there was one.
 */
function registerViewLogsCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("continue.viewLogs", () => {
      activationErrorChannel?.show(true);
      void vscode.commands.executeCommand("workbench.action.toggleDevTools");
    }),
  );
}

export function activate(context: vscode.ExtensionContext) {
  registerViewLogsCommand(context);

  return dynamicImportAndActivate(context).catch((e) => {
    console.log("Error activating extension: ", e);
    const message = e instanceof Error ? e.message : String(e);
    activationErrorChannel ??= vscode.window.createOutputChannel("NextCLI");
    context.subscriptions.push(activationErrorChannel);
    activationErrorChannel.appendLine(
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

export async function deactivate() {
  // Stop the opt-in metrics exporter (core/util/telemetry/coreTelemetry.ts)
  // and send what it has, instead of leaving it to the extension host's exit.
  const { coreTelemetry } = await import("core/util/telemetry/coreTelemetry");
  await coreTelemetry.shutdown();
}
