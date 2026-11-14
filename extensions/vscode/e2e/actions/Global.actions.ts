import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import {
  By,
  EditorView,
  InputBox,
  Key,
  TextEditor,
  until,
  VSBrowser,
  Workbench,
} from "vscode-extension-tester";

import { DEFAULT_TIMEOUT } from "../constants";
import { TestUtils } from "../TestUtils";

/**
 * Command palette labels of the built-in commands the tests run, as VS Code
 * (package.json config.e2eVscodeVersion) shows them. The extension's own
 * commands are looked up in its package.json instead.
 */
const BUILTIN_COMMAND_LABELS: Record<string, string | string[]> = {
  "notifications.clearAll": "Notifications: Clear All Notifications",
  "workbench.action.files.newUntitledFile": "File: New Untitled Text File",
  "workbench.action.files.save": "File: Save",
  "workbench.action.files.saveAs": "File: Save As...",
  "workbench.action.files.saveAll": "Save All",
  "workbench.action.editor.changeLanguageMode": "Change Language Mode",
  // Listed only while the secondary side bar is visible
  "workbench.action.closeAuxiliaryBar": "View: Hide Secondary Side Bar",
  "workbench.action.moveView": "View: Move View",
  "workbench.action.focusActiveEditorGroup": "View: Focus Active Editor Group",
  "workbench.action.revertAndCloseActiveEditor":
    "View: Revert and Close Editor",
  "workbench.action.quickOpen": "Go to File...",
  "editor.action.selectAll": "Select All",
  // The prefix is the view's container, which changes when the view is moved
  "continue.continueGUIView.focus": [
    "NextCLI: Focus on NextCLI View",
    "User View Container: Focus on NextCLI View",
  ],
};

/** A command ID such as `continue.newSession`: dotted, no spaces */
const COMMAND_ID = /^[\w-]+(\.[\w-]+)+$/;

export class GlobalActions {
  /** The workspace folder; e2e:test opens it when VS Code starts */
  static defaultFolder = "e2e/fixture-workspace";
  public static defaultNewFilename = "test.py";

  /**
   * Fails unless the window shows the fixture workspace. It is opened at
   * launch only: opening it later goes through VS Code's CLI, which can
   * drop the request and leave the tests running with no folder.
   */
  public static async expectTestWorkspaceOpen() {
    const title = await VSBrowser.instance.driver.getTitle();
    expect(
      title,
      `window title; is ${GlobalActions.defaultFolder} open?`,
    ).to.include(path.basename(GlobalActions.defaultFolder));
  }

  public static async openTestWorkspace() {
    await GlobalActions.expectTestWorkspaceOpen();
    await GlobalActions.clearAllNotifications();
  }

  public static async clearAllNotifications() {
    await GlobalActions.runCommand("notifications.clearAll");
  }

  /** The label(s) the command palette can show for a command ID */
  public static commandLabel(commandId: string): string | string[] {
    const builtin = BUILTIN_COMMAND_LABELS[commandId];
    if (builtin) return builtin;

    const manifest = JSON.parse(
      fs.readFileSync(path.resolve("package.json"), "utf8"),
    );
    const contributed = manifest.contributes.commands.find(
      (c: { command: string }) => c.command === commandId,
    );
    if (contributed) {
      return contributed.category
        ? `${contributed.category}: ${contributed.title}`
        : contributed.title;
    }
    throw new Error(
      `No command palette label known for ${commandId}. Add it to BUILTIN_COMMAND_LABELS in Global.actions.ts.`,
    );
  }

  /**
   * Runs a command through the command palette and waits for the palette to
   * close. Takes a command ID (preferred) or, when the palette label itself
   * is under test, an exact label.
   *
   * Unlike ExTester's Workbench.executeCommand, it never presses Enter on
   * whatever happens to be highlighted: it clicks the pick whose label is
   * exactly the expected one, or throws and lists the picks it saw. Only
   * opening the palette is retried; the click never is.
   *
   * Leaves the driver in the top-level frame. Callers that were inside a
   * webview must switch into it again.
   */
  public static async runCommand(command: string): Promise<void> {
    await GlobalActions.selectCommand(command);
    await TestUtils.waitForSuccess(
      async () => {
        for (const widget of await VSBrowser.instance.driver.findElements(
          By.css(".quick-input-widget"),
        )) {
          if (await widget.isDisplayed()) {
            throw new Error("The command palette is still open");
          }
        }
      },
      DEFAULT_TIMEOUT.SM,
      100,
      `the palette to close after ${command}`,
    );
  }

  /**
   * Runs a command that asks for more input (a second quick pick) and
   * returns that input box. Choose from it with selectPick.
   */
  public static async runCommandWithInput(command: string): Promise<InputBox> {
    await GlobalActions.selectCommand(command);
    return new InputBox().wait();
  }

  /**
   * Waits for a pick labelled exactly `label` (or one of `label`) in an open
   * quick input and clicks it. Throws with the visible labels if it doesn't
   * show up.
   */
  public static async selectPick(input: InputBox, label: string | string[]) {
    const wanted = Array.isArray(label) ? label : [label];
    const pick = await TestUtils.waitForSuccess(
      async () => {
        const picks = await input.getQuickPicks();
        const labels = await Promise.all(picks.map((p) => p.getLabel()));
        const index = labels.findIndex((l) => wanted.includes(l));
        if (index < 0) {
          throw new Error(
            `No pick labelled ${wanted.map((w) => `"${w}"`).join(" or ")}. Visible picks: ${JSON.stringify(labels)}`,
          );
        }
        return picks[index];
      },
      DEFAULT_TIMEOUT.SM,
      250,
      `the ${wanted.map((w) => `"${w}"`).join(" or ")} pick`,
    );
    await pick.select();
  }

  /**
   * Opens the palette, types the command and clicks its pick. Opening and
   * typing run nothing, so they are retried: a focus change (such as the GUI
   * taking focus after it opens) closes the palette under the cursor. The
   * click is never retried.
   */
  private static async selectCommand(command: string) {
    const isId = COMMAND_ID.test(command);
    const label = isId ? GlobalActions.commandLabel(command) : command;
    const driver = VSBrowser.instance.driver;
    await driver.switchTo().defaultContent();

    const palette = await TestUtils.waitForSuccess(
      async () => {
        const input = await GlobalActions.openCommandPalette();
        // Typing an exact command ID lists that command, under its label
        await input.setText(`>${command}`);
        if ((await input.getText()) !== `>${command}`) {
          throw new Error(`The palette shows "${await input.getText()}"`);
        }
        return input;
      },
      DEFAULT_TIMEOUT.MD,
      500,
      `type ${command} into the command palette`,
    );
    await GlobalActions.selectPick(palette, label);
  }

  /**
   * Presses F1 and waits for the palette to be visible. F1 needs no modifier
   * keys: ExTester's openCommandPrompt presses Ctrl and Shift and never
   * releases them. InputBox.create is not enough on its own: it only waits for
   * the element to exist, and VS Code keeps it in the page while hidden.
   */
  private static async openCommandPalette(): Promise<InputBox> {
    const driver = VSBrowser.instance.driver;
    await driver.actions().sendKeys(Key.F1).perform();
    const widget = await driver.wait(
      until.elementLocated(By.css(".quick-input-widget")),
      DEFAULT_TIMEOUT.XS,
    );
    await driver.wait(until.elementIsVisible(widget), 2000);
    return new InputBox().wait();
  }

  public static async createAndOpenNewTextFile(): Promise<{
    editor: TextEditor;
  }> {
    await GlobalActions.runCommand("workbench.action.files.newUntitledFile");
    const editor = (await new EditorView().openEditor(
      "Untitled-1",
    )) as TextEditor;

    return { editor };
  }

  public static async createAndSaveNewFile(
    filename = GlobalActions.defaultNewFilename,
  ): Promise<{
    editor: TextEditor;
  }> {
    let { editor } = await GlobalActions.createAndOpenNewTextFile();

    const inputBox = await GlobalActions.runCommandWithInput(
      "workbench.action.files.saveAs",
    );

    // Get current path and replace filename
    const currentPath = await inputBox.getText();
    const pathParts = currentPath.split(/[\/\\]/);
    pathParts[pathParts.length - 1] = filename;
    const newPath = pathParts.join("/");

    await inputBox.setText(newPath);

    await inputBox.confirm();
    await TestUtils.waitForTimeout(DEFAULT_TIMEOUT.XS);

    editor = (await new EditorView().openEditor(filename)) as TextEditor;

    return { editor };
  }

  public static async deleteFileFromFolder(
    filename = GlobalActions.defaultNewFilename,
    folder = GlobalActions.defaultFolder,
  ): Promise<void> {
    const fs = require("fs");
    const path = require("path");

    const folderPath = path.join(process.cwd(), folder);
    const filePath = path.join(folderPath, filename);

    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      console.warn(`Failed to delete file ${filePath}:`, error);
    }
  }

  static async setNextEditEnabled(enabled: boolean) {
    const workbench = new Workbench();
    process.env.CONTINUE_E2E_NON_NEXT_EDIT_TEST = "true";

    await GlobalActions.clearAllNotifications();
    const statusBar = await workbench.getStatusBar();

    // The status bar item shows "(NE)" while Next Edit is on. Keep reading it
    // until it matches, toggling once if it doesn't: a single early read can
    // miss the extension turning Next Edit on after it loads its config.
    let toggled = false;
    await TestUtils.waitForSuccess(async () => {
      const item = await statusBar.findElement(
        By.xpath("//*[contains(text(), 'NextCLI')]"),
      );
      const text =
        (await item.getText()) ||
        (await item.getAttribute("textContent")) ||
        "";
      const hasNE = text.includes("(NE)");
      console.log("Status bar text:", text, "hasNE:", hasNE);

      if (hasNE === enabled) {
        return;
      }
      // Toggles at most once, so the retries only repeat the read
      if (!toggled) {
        toggled = true;
        await GlobalActions.runCommand("continue.toggleNextEditEnabled");
        await GlobalActions.clearAllNotifications();
      }
      throw new Error(`Next Edit is ${hasNE ? "on" : "off"}`);
    }, DEFAULT_TIMEOUT.MD);
  }

  static async disableNextEdit() {
    await this.setNextEditEnabled(false);
  }
}
