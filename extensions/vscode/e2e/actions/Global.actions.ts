import * as path from "path";

import {
  By,
  EditorView,
  InputBox,
  TextEditor,
  VSBrowser,
  Workbench,
} from "vscode-extension-tester";

import { DEFAULT_TIMEOUT } from "../constants";
import { TestUtils } from "../TestUtils";

export class GlobalActions {
  static defaultFolder = "e2e/test-continue";
  public static defaultNewFilename = "test.py";

  /**
   * The e2e:test script opens the folder at launch (--open_resource). Opening
   * it afterwards goes through VS Code's CLI, which can drop the request and
   * leave no folder open; tests then fail on missing workspace files. Only
   * fall back to that when the folder isn't open, and fail clearly if it
   * still isn't.
   */
  public static async openTestWorkspace() {
    const folderName = path.basename(GlobalActions.defaultFolder);
    const isOpen = async () =>
      (await VSBrowser.instance.driver.getTitle()).includes(folderName);

    if (!(await isOpen())) {
      await VSBrowser.instance.openResources(GlobalActions.defaultFolder);
      await TestUtils.waitForSuccess(async () => {
        if (!(await isOpen())) {
          throw new Error(
            `Workspace ${GlobalActions.defaultFolder} did not open (window title: "${await VSBrowser.instance.driver.getTitle()}")`,
          );
        }
      }, DEFAULT_TIMEOUT.MD);
    }

    await new Workbench().executeCommand(
      "Notifications: Clear All Notifications",
    );
  }

  public static async clearAllNotifications() {
    await new Workbench().executeCommand(
      "Notifications: Clear All Notifications",
    );
  }

  public static async createAndOpenNewTextFile(): Promise<{
    editor: TextEditor;
  }> {
    await new Workbench().executeCommand("Create: New File...");
    await (
      await InputBox.create(DEFAULT_TIMEOUT.MD)
    ).selectQuickPick("Text File");
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

    await new Workbench().executeCommand("File: Save As...");
    const inputBox = await InputBox.create(DEFAULT_TIMEOUT.MD);

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
      if (!toggled) {
        toggled = true;
        await workbench.executeCommand("NextCLI: Toggle Next Edit");
        await GlobalActions.clearAllNotifications();
      }
      throw new Error(`Next Edit is ${hasNE ? "on" : "off"}`);
    }, DEFAULT_TIMEOUT.MD);
  }

  static async disableNextEdit() {
    await this.setNextEditEnabled(false);
  }
}
