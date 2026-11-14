import {
  By,
  Key,
  until,
  VSBrowser,
  WebDriver,
  WebElement,
  WebView,
} from "vscode-extension-tester";

import { DEFAULT_TIMEOUT } from "../constants";
import { GUISelectors } from "../selectors/GUI.selectors";
import { TestUtils } from "../TestUtils";
import { GlobalActions } from "./Global.actions";

export class GUIActions {
  /**
   * Moves the NextCLI view into its own secondary side bar entry, where the
   * extension's Cmd+L hides it again, and leaves it closed. Runs once per
   * VS Code instance, from e2e/Baseline.ts.
   */
  public static async moveToSecondarySideBar() {
    // Move the view before its webview first loads: a loading webview takes
    // focus, which closes the quick pick. Nothing moves until the last pick
    // is clicked, so a failure before that starts over.
    await TestUtils.waitForSuccess(
      async () => {
        const moveView = await GlobalActions.runCommandWithInput(
          "workbench.action.moveView",
        );
        await GlobalActions.selectPick(moveView, "NextCLI");
        await GlobalActions.selectPick(
          moveView,
          "New Secondary Side Bar Entry",
        );
      },
      DEFAULT_TIMEOUT.MD,
      500,
      "move the NextCLI view to the secondary side bar",
    );

    // Focusing the view must now show the secondary side bar
    await GUIActions.close();
    await GUIActions.open();
    await GUIActions.close();
  }

  /** Whether the secondary side bar, which holds only the GUI, is shown */
  public static async isOpen() {
    const driver = VSBrowser.instance.driver;
    await driver.switchTo().defaultContent();
    const bars = await driver.findElements(
      By.id("workbench.parts.auxiliarybar"),
    );
    return bars.length > 0 && (await bars[0].isDisplayed());
  }

  /**
   * Shows the GUI if it's hidden and switches into its iframe once the main
   * input exists. Unlike Cmd+L, it never hides the GUI or starts a new
   * session. The GUI may take focus a moment later; focus the code editor
   * with GlobalActions.focusEditor before typing into it.
   */
  public static async open() {
    if (!(await GUIActions.isOpen())) {
      await GlobalActions.runCommand("continue.continueGUIView.focus");
      await TestUtils.waitForSuccess(
        async () => {
          if (!(await GUIActions.isOpen())) {
            throw new Error("The secondary side bar is hidden");
          }
        },
        DEFAULT_TIMEOUT.MD,
        250,
        "the GUI to open",
      );
    }
    return TestUtils.waitForSuccess(
      async () => {
        const gui = await GUIActions.switchToReactIframe();
        await GUISelectors.getMainInput(gui.view);
        return gui;
      },
      DEFAULT_TIMEOUT.MD,
      500,
      "the GUI's main input",
    );
  }

  /** Hides the GUI if it's shown. Leaves the driver in the top-level frame. */
  public static async close() {
    if (!(await GUIActions.isOpen())) return;
    await GlobalActions.runCommand("workbench.action.closeAuxiliaryBar");
    await TestUtils.waitForSuccess(
      async () => {
        if (await GUIActions.isOpen()) {
          throw new Error("The secondary side bar is still shown");
        }
      },
      DEFAULT_TIMEOUT.SM,
      250,
      "the GUI to close",
    );
  }

  /**
   * Stops a turn that is still running and waits until it has stopped.
   * Returns whether there was one. A "Stop the running turn?" dialog is
   * answered "Keep running" first, so the turn is stopped here instead.
   */
  public static async stopRunningTurn(view: WebView): Promise<boolean> {
    for (const button of await GUISelectors.getDialogButtons(
      view,
      "Keep running",
    )) {
      await button.click();
    }
    const [stopButton] = await GUISelectors.getStopStreamingButtons(view);
    if (!stopButton) return false;
    await stopButton.click();
    await TestUtils.waitForSuccess(
      async () => {
        if ((await GUISelectors.getStopStreamingButtons(view)).length > 0) {
          throw new Error("The stop button is still shown");
        }
      },
      DEFAULT_TIMEOUT.SM,
      250,
      "the running turn to stop",
    );
    return true;
  }

  /**
   * Switches from the top-level frame into the GUI's React iframe. Starts
   * from the top-level frame, so it is safe to call again after a failure.
   */
  public static switchToReactIframe = async () => {
    const view = new WebView();
    const driver = view.getDriver();
    await driver.switchTo().defaultContent();

    let continueIFrame: WebElement | undefined = undefined;
    for (const iframe of await GUISelectors.getAllIframes(driver)) {
      const src = await iframe.getAttribute("src");
      if (src?.includes("extensionId=nextcli.nextcli")) {
        continueIFrame = iframe;
        break;
      }
    }
    if (!continueIFrame) {
      throw new Error("Could not find the NextCLI webview iframe");
    }
    await driver.switchTo().frame(continueIFrame);

    const reactIFrame = await driver.wait(
      until.elementLocated(By.css("iframe")),
      DEFAULT_TIMEOUT.XS,
      "Could not find the GUI's React iframe",
    );
    await driver.switchTo().frame(reactIFrame);
    return {
      view,
      driver,
    };
  };

  public static selectModelFromDropdown = async (
    view: WebView,
    option: string,
  ) => {
    const dropdownButton = await GUISelectors.getModelDropdownButton(view);
    await dropdownButton.click();

    // Models with settings open on the settings view; the list is under Model
    const modelRow = await TestUtils.waitForSuccess(async () => {
      const menu = await view.findWebElement(
        By.css('[data-testid="model-select-menu"]'),
      );
      return menu;
    }).then(() => GUISelectors.getModelListRow(view));
    if (modelRow.length > 0) {
      await modelRow[0].click();
    }

    const dropdownOption = await TestUtils.waitForSuccess(() => {
      return GUISelectors.getModelDropdownOption(view, option);
    });

    await dropdownOption.click();
  };

  /**
   * Selects a model by title if needed, then checks the GUI shows it. The
   * title must match exactly: "Mock" must not count as "TOOL MOCK LLM".
   */
  public static async useModel(view: WebView, title: string) {
    // textContent, not getText: labels can be hidden in a narrow side bar
    const shown = async () =>
      (
        (await (
          await GUISelectors.getModelDropdownTitle(view)
        ).getAttribute("textContent")) ?? ""
      ).trim();
    if ((await shown()) !== title) {
      await GUIActions.selectModelFromDropdown(view, title);
    }
    await TestUtils.waitForSuccess(
      async () => {
        const text = await shown();
        if (text !== title) {
          throw new Error(`The model button shows "${text}"`);
        }
      },
      DEFAULT_TIMEOUT.SM,
      250,
      `the ${title} model to be selected`,
    );
  }

  /** Selects a mode (Agent, Chat, Plan) if needed, then checks it exactly */
  public static async useMode(view: WebView, mode: string) {
    // The mode's label is hidden below Tailwind's sm width, which the side
    // bar is: read textContent, not the visible text. The button's icons
    // have no text, so its textContent is the label alone.
    const shown = async () =>
      (
        (await (
          await GUISelectors.getModeDropdownButton(view)
        ).getAttribute("textContent")) ?? ""
      ).trim();
    if ((await shown()) !== mode) {
      await GUIActions.selectModeFromDropdown(view, mode);
    }
    await TestUtils.waitForSuccess(
      async () => {
        const text = await shown();
        if (text !== mode) {
          throw new Error(`The mode button shows "${text}"`);
        }
      },
      DEFAULT_TIMEOUT.SM,
      250,
      `${mode} mode to be selected`,
    );
  }

  public static selectModeFromDropdown = async (
    view: WebView,
    option: string,
  ) => {
    const dropdownButton = await GUISelectors.getModeDropdownButton(view);
    await dropdownButton.click();

    const dropdownOption = await TestUtils.waitForSuccess(() => {
      return GUISelectors.getModeDropdownOption(view, option);
    });

    await dropdownOption.click();
  };

  public static async sendMessage({
    view,
    message,
    inputFieldIndex,
  }: {
    view: WebView;
    message: string;
    inputFieldIndex: number;
  }) {
    const editor = await GUISelectors.getMessageInputFieldAtIndex(
      view,
      inputFieldIndex,
    );
    await editor.sendKeys(message);
    await editor.sendKeys(Key.ENTER);
  }

  /**
   * Waits until `element`, in the driver's current frame, has keyboard focus.
   * The GUI focuses its input a moment after it opens (a 20ms timer), so a
   * single read right away can see the page's body instead.
   */
  public static async waitForFocus(
    driver: WebDriver,
    element: WebElement,
    what: string,
  ) {
    await TestUtils.waitForSuccess(
      async () => {
        const focused = await driver.executeScript<boolean>(
          "return document.activeElement === arguments[0];",
          element,
        );
        if (!focused) throw new Error(`${what} doesn't have focus`);
      },
      DEFAULT_TIMEOUT.SM,
      100,
      `${what} to have focus`,
    );
  }

  public static async executeFocusContinueInputShortcut(driver: WebDriver) {
    return driver
      .actions()
      .keyDown(TestUtils.osControlKey)
      .sendKeys("l")
      .keyUp(TestUtils.osControlKey)
      .perform();
  }
}
