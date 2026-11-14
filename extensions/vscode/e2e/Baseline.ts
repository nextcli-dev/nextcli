/**
 * Setup shared by every e2e test file, which each import this module.
 *
 * The hooks register once, at module load, on mocha's root suite. That puts
 * them after ExTester's own root hook that launches VS Code; hooks passed
 * to mocha as rootHooks would run before it. They come from ExTester, which
 * takes a screenshot when one fails.
 *
 * Every test starts from the same state, so no test depends on what the one
 * before it left behind:
 * - the GUI hidden, in an empty new session, with no turn running and not in
 *   Edit mode
 * - no editors open, no palette or dialog open, no notifications
 * Tests choose the model, mode and files they need themselves.
 */
import { expect } from "chai";
import {
  afterEach,
  before,
  beforeEach,
  Key,
  VSBrowser,
} from "vscode-extension-tester";

import { GlobalActions } from "./actions/Global.actions";
import { GUIActions } from "./actions/GUI.actions";
import { DEFAULT_TIMEOUT } from "./constants";
import { GUISelectors } from "./selectors/GUI.selectors";
import { TestUtils } from "./TestUtils";

/**
 * The size of every VS Code window, local and CI, so layouts match: side bar
 * widths, wrapping and the settings page depend on it. It is VS Code's own
 * default size, which settings.json asks for with
 * "window.newWindowDimensions": "default". ExTester's default, "maximized",
 * gave about 1470x922 on a laptop and had no effect under CI's Xvfb, which
 * has no window manager. ChromeDriver can't resize an Electron window.
 */
export const WINDOW_SIZE = { width: 1200, height: 800 };

/** Once per VS Code instance */
before(async function () {
  const size = await VSBrowser.instance.driver.executeScript<{
    width: number;
    height: number;
  }>("return { width: window.innerWidth, height: window.innerHeight };");
  expect(
    size,
    "VS Code window size (is the screen smaller than this?)",
  ).to.deep.equal(WINDOW_SIZE);

  await GlobalActions.expectTestWorkspaceOpen();
  await GlobalActions.setNextEditEnabled(false);
  await GUIActions.moveToSecondarySideBar();
});

/**
 * After a failed test, log what had keyboard focus. Typing, inline
 * suggestions and ExTester's editor helpers all depend on it, and a
 * screenshot doesn't show it.
 */
afterEach(async function (this: Mocha.Context) {
  if (this.currentTest?.state !== "failed") return;
  try {
    const driver = VSBrowser.instance.driver;
    await driver.switchTo().defaultContent();
    const focus = await driver.executeScript<string>(`
      const el = document.activeElement;
      if (!el) return "nothing";
      const describe = (e) =>
        e.tagName.toLowerCase() +
        (e.id ? "#" + e.id : "") +
        (typeof e.className === "string" && e.className
          ? "." + e.className.trim().split(/\\s+/).slice(0, 4).join(".")
          : "");
      const src = el.tagName === "IFRAME" ? " src=" + (el.getAttribute("src") || "").slice(0, 120) : "";
      const part = el.closest("[id^='workbench.parts.']");
      return describe(el) + src + " in " + (part ? part.id : "no workbench part");
    `);
    console.log(`  focus at failure: ${focus}`);
  } catch (e) {
    console.log(`  focus at failure: unknown (${(e as Error).message})`);
  }
});

/** Before every test */
beforeEach(async function () {
  const repairs = await resetToBaseline();
  // A clean run logs nothing here. A repair means the previous test left
  // something running or open; the reset fixed it, but say so.
  if (repairs.length > 0) {
    console.log(`  reset: ${repairs.join("; ")}`);
  }
});

async function resetToBaseline(): Promise<string[]> {
  const repairs: string[] = [];

  for (const what of await GlobalActions.closeQuickInputAndDialogs()) {
    repairs.push(`closed ${what}`);
  }

  // Stop a running turn before anything switches sessions: switching while
  // a turn runs asks "Stop the running turn?" in a dialog over the GUI.
  let { view } = await GUIActions.open();
  if (await GUIActions.stopRunningTurn(view)) {
    repairs.push("stopped a turn that was still running");
  }
  // Leave Edit mode first: from Edit mode, New Session can reopen the last
  // session instead of starting an empty one.
  await GlobalActions.runCommand("continue.exitEditMode");
  await GlobalActions.runCommand("continue.newSession");
  ({ view } = await GUIActions.open());
  // New Session keeps text typed but not sent (it only replaces a session
  // with messages); clear it
  const mainInput = await GUISelectors.getMainInput(view);
  if ((await mainInput.getText()).trim() !== "") {
    await mainInput.sendKeys(
      Key.chord(TestUtils.osControlKey, "a"),
      Key.BACK_SPACE,
    );
  }
  await TestUtils.waitForSuccess(
    async () => {
      expect(
        (await GUISelectors.getThreadMessages(view)).length,
        "messages in the new session",
      ).to.equal(0);
      expect(
        (await GUISelectors.getEditAcceptButtons(view)).length,
        "Edit mode accept buttons in the new session",
      ).to.equal(0);
      expect(
        (await (await GUISelectors.getMainInput(view)).getText()).trim(),
        "the main input in the new session",
      ).to.equal("");
    },
    DEFAULT_TIMEOUT.MD,
    250,
    "an empty new session",
  );
  await GUIActions.close();

  await GlobalActions.closeAllEditors();
  await GlobalActions.clearAllNotifications();
  await GlobalActions.runCommand("workbench.action.focusActiveEditorGroup");
  return repairs;
}
