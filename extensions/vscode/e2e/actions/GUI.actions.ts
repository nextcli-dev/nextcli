import {
  By,
  InputBox,
  Key,
  WebDriver,
  WebElement,
  WebView,
  Workbench,
} from "vscode-extension-tester";

import { DEFAULT_TIMEOUT } from "../constants";
import { GUISelectors } from "../selectors/GUI.selectors";
import { TestUtils } from "../TestUtils";

export class GUIActions {
  public static moveContinueToSidebar = async (driver: WebDriver) => {
    await GUIActions.toggleGui();
    await TestUtils.waitForSuccess(async () => {
      await new Workbench().executeCommand("View: Move View");
      await (
        await InputBox.create(DEFAULT_TIMEOUT.MD)
      ).selectQuickPick("NextCLI");
      await (
        await InputBox.create(DEFAULT_TIMEOUT.MD)
      ).selectQuickPick("New Secondary Side Bar Entry");
    });

    // first call focuses the input
    await TestUtils.waitForTimeout(DEFAULT_TIMEOUT.XS);
    await GUIActions.executeFocusContinueInputShortcut(driver);

    // Widen the side bar while it's open; the width stays when it reopens
    await TestUtils.waitForTimeout(DEFAULT_TIMEOUT.XS);
    await GUIActions.widenSecondarySideBar(driver);

    // second call closes the gui
    await TestUtils.waitForTimeout(DEFAULT_TIMEOUT.XS);
    await GUIActions.executeFocusContinueInputShortcut(driver);
  };

  public static switchToReactIframe = async () => {
    const view = new WebView();
    const driver = view.getDriver();

    const iframes = await GUISelectors.getAllIframes(driver);
    let continueIFrame: WebElement | undefined = undefined;
    for (let i = 0; i < iframes.length; i++) {
      const iframe = iframes[i];
      const src = await iframe.getAttribute("src");
      if (src?.includes("extensionId=nextcli.nextcli")) {
        continueIFrame = iframe;
        break;
      }
    }

    if (!continueIFrame) {
      throw new Error("Could not find Continue iframe");
    }

    await driver.switchTo().frame(continueIFrame);

    await new Promise((res) => {
      setTimeout(res, 500);
    });

    const reactIFrame = await GUISelectors.getReactIframe(driver);

    if (!reactIFrame) {
      throw new Error("Could not find React iframe");
    }

    await driver.switchTo().frame(reactIFrame);
    return {
      view,
      driver,
    };
  };

  public static toggleGui = async () => {
    return TestUtils.waitForSuccess(() =>
      new Workbench().executeCommand("continue.focusContinueInput"),
    );
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

  public static async executeFocusContinueInputShortcut(driver: WebDriver) {
    return driver
      .actions()
      .keyDown(TestUtils.osControlKey)
      .sendKeys("l")
      .keyUp(TestUtils.osControlKey)
      .perform();
  }

  /**
   * Runs a command palette command (the history, new-session and settings
   * buttons are VS Code view-title actions, outside the webview) and returns
   * the GUI's iframe again, which callers must use from then on.
   */
  public static async runCommandFromGui(view: WebView, command: string) {
    await view.switchBack();
    // The palette's input is sometimes not interactable yet right after
    // leaving the webview; retry like toggleGui does
    await TestUtils.waitForSuccess(() =>
      new Workbench().executeCommand(command),
    );
    return GUIActions.switchToReactIframe();
  }

  /**
   * Drags the secondary side bar's left edge towards the editor. The default
   * width is too narrow for the settings page ("Screen width too small"
   * below Tailwind's sm breakpoint).
   */
  public static async widenSecondarySideBar(driver: WebDriver, by = 700) {
    const auxiliaryBar = await driver.findElement(
      By.id("workbench.parts.auxiliarybar"),
    );
    const leftEdge = (await auxiliaryBar.getRect()).x;
    let sash: WebElement | undefined;
    let closest = Infinity;
    for (const candidate of await driver.findElements(
      By.css(".monaco-sash.vertical"),
    )) {
      const rect = await candidate.getRect();
      const distance = Math.abs(rect.x + rect.width / 2 - leftEdge);
      if (rect.height > 100 && distance < closest) {
        closest = distance;
        sash = candidate;
      }
    }
    if (!sash) {
      throw new Error("Could not find the secondary side bar's sash");
    }
    await driver
      .actions()
      .move({ origin: sash })
      .press()
      .move({ origin: sash, x: -by, y: 0 })
      .release()
      .perform();
    await TestUtils.waitForTimeout(500);
  }

  /**
   * Sets a built-in tool's policy on the Tools settings page and returns to
   * the chat. Returns the GUI's iframe, which callers must use from then on.
   * desiredState: 0 = Automatic, 1 = Excluded, 2 = Ask First, or the label.
   */
  public static async toggleToolPolicy(
    view: WebView,
    toolName: string,
    desiredState: number | string,
  ): Promise<WebView> {
    const label =
      typeof desiredState === "number"
        ? (["Automatic", "Excluded", "Ask First"][desiredState] ?? "Ask First")
        : desiredState;

    ({ view } = await GUIActions.runCommandFromGui(
      view,
      "NextCLI: Open Settings",
    ));
    await (
      await TestUtils.waitForSuccess(() => GUISelectors.getToolsTab(view))
    ).click();

    // The group starts collapsed, and its tools aren't rendered until opened
    const groupHeader = await TestUtils.waitForSuccess(() =>
      GUISelectors.getToolGroupHeader(view, "Built-In"),
    );
    if ((await groupHeader.getAttribute("aria-expanded")) !== "true") {
      await groupHeader.click();
    }

    const policyButton = await TestUtils.waitForSuccess(() =>
      GUISelectors.getToolPolicyButton(view, toolName),
    );
    if (!(await policyButton.getText()).includes(label)) {
      await policyButton.click();
      await (
        await TestUtils.waitForSuccess(() =>
          GUISelectors.getListboxOption(view, label),
        )
      ).click();
      await TestUtils.waitForSuccess(async () => {
        if (!(await policyButton.getText()).includes(label)) {
          throw new Error(`${toolName} policy is not ${label} yet`);
        }
      });
    }

    await (
      await TestUtils.waitForSuccess(() => GUISelectors.getBackButton(view))
    ).click();
    await TestUtils.waitForTimeout(500);
    return view;
  }
}
