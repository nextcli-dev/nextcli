import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

import {
  By,
  InputBox,
  Key,
  QuickPickItem,
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

/** WebDriver errors that mean a click never reached the element */
const CLICK_NOT_DELIVERED = new Set([
  "ElementNotInteractableError",
  "ElementClickInterceptedError",
  "StaleElementReferenceError",
]);

/** A command ID such as `continue.newSession`: dotted, no spaces */
const COMMAND_ID = /^[\w-]+(\.[\w-]+)+$/;

export class GlobalActions {
  /** The workspace folder; e2e:test opens it when VS Code starts */
  static defaultFolder = "e2e/fixture-workspace";

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
   * exactly the expected one, or throws and lists the picks it saw.
   *
   * Opening the palette, typing and finding the pick run nothing, so a
   * failure there is retried from the start; so is a click WebDriver reports
   * it never delivered (see clickPick). A focus change can close the palette
   * at any of those points, for example the GUI focusing its input when it
   * loads. A click that may have run the command is never repeated.
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
  public static async selectPick(
    input: InputBox,
    label: string | string[],
    timeout = DEFAULT_TIMEOUT.SM,
  ) {
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
      timeout,
      250,
      `the ${wanted.map((w) => `"${w}"`).join(" or ")} pick`,
    );
    await GlobalActions.clickPick(pick);
  }

  /**
   * Clicks a pick. When WebDriver reports the click was never delivered (the
   * pick went stale, hidden or covered, for example because the quick input
   * closed), the error is left retryable, since nothing ran. Any other error
   * is marked so waitForSuccess won't repeat a click that may have landed.
   */
  private static async clickPick(pick: QuickPickItem) {
    try {
      await pick.select();
    } catch (e) {
      if (CLICK_NOT_DELIVERED.has((e as Error)?.name)) throw e;
      throw TestUtils.doNotRetry(e);
    }
  }

  private static async selectCommand(command: string) {
    const isId = COMMAND_ID.test(command);
    const label = isId ? GlobalActions.commandLabel(command) : command;

    await TestUtils.waitForSuccess(
      async () => {
        // A palette left open by a failed attempt
        await GlobalActions.closeVisible(".quick-input-widget");
        const palette = await GlobalActions.openCommandPalette();
        // Typing an exact command ID lists that command, under its label
        await palette.setText(`>${command}`);
        if ((await palette.getText()) !== `>${command}`) {
          throw new Error(`The palette shows "${await palette.getText()}"`);
        }
        await GlobalActions.selectPick(palette, label, DEFAULT_TIMEOUT.XS);
      },
      DEFAULT_TIMEOUT.MD,
      500,
      `run ${command} from the command palette`,
    );
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

  /**
   * Opens a new untitled text file and returns it as the active editor.
   * Doesn't look it up by title: VS Code names an untitled file after its
   * first line, so the title changes as soon as the test types.
   */
  public static async openNewUntitledFile(): Promise<TextEditor> {
    const before = await GlobalActions.openEditorCount();
    await GlobalActions.runCommand("workbench.action.files.newUntitledFile");
    await TestUtils.waitForSuccess(
      async () => {
        expect(await GlobalActions.openEditorCount()).to.equal(before + 1);
      },
      DEFAULT_TIMEOUT.SM,
      250,
      "the new untitled file's tab",
    );
    return new TextEditor();
  }

  /**
   * Opens a file in the workspace through Go to File and returns it as the
   * active editor. `relativePath` is relative to the workspace folder.
   */
  public static async openWorkspaceFile(
    relativePath: string,
  ): Promise<TextEditor> {
    const fileName = path.basename(relativePath);
    const goToFile = await GlobalActions.runCommandWithInput(
      "workbench.action.quickOpen",
    );
    await goToFile.setText(relativePath);
    await GlobalActions.selectPick(goToFile, fileName);
    await TestUtils.waitForSuccess(
      async () => {
        const editor = new TextEditor();
        expect(await editor.getTitle()).to.equal(fileName);
      },
      DEFAULT_TIMEOUT.SM,
      250,
      `${relativePath} to open`,
    );
    return new TextEditor();
  }

  /** Gives `editor` keyboard focus and checks that it has it */
  public static async focusEditor(editor: TextEditor) {
    await VSBrowser.instance.driver.switchTo().defaultContent();
    await editor.focus();
    expect(await editor.hasFocus(), "the code editor has focus").to.equal(true);
  }

  public static async openEditorCount() {
    const driver = VSBrowser.instance.driver;
    await driver.switchTo().defaultContent();
    return (await driver.findElements(By.css(".editor-group-container .tab")))
      .length;
  }

  /**
   * Closes every editor without a save prompt ("View: Revert and Close
   * Editor" on each). Returns how many were open.
   */
  public static async closeAllEditors(): Promise<number> {
    const open = await GlobalActions.openEditorCount();
    for (let i = 0; i < open; i++) {
      await GlobalActions.runCommand(
        "workbench.action.revertAndCloseActiveEditor",
      );
    }
    expect(
      await GlobalActions.openEditorCount(),
      "open editors after closing them all",
    ).to.equal(0);
    return open;
  }

  /**
   * Closes a command palette or quick pick, and a VS Code modal dialog, left
   * open. Returns what it closed.
   */
  public static async closeQuickInputAndDialogs(): Promise<string[]> {
    const closed: string[] = [];
    if (await GlobalActions.closeVisible(".quick-input-widget")) {
      closed.push("a quick input");
    }
    if (await GlobalActions.closeVisible(".monaco-dialog-box")) {
      closed.push("a dialog");
    }
    return closed;
  }

  /** Presses Escape while an element matching `css` is visible */
  private static async closeVisible(css: string): Promise<boolean> {
    const driver = VSBrowser.instance.driver;
    await driver.switchTo().defaultContent();
    for (const element of await driver.findElements(By.css(css))) {
      if (await element.isDisplayed()) {
        await driver.actions().sendKeys(Key.ESCAPE).perform();
        await driver.wait(until.elementIsNotVisible(element), 2000);
        return true;
      }
    }
    return false;
  }

  static async setNextEditEnabled(enabled: boolean) {
    const workbench = new Workbench();

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
}
