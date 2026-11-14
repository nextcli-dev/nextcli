/**
 * Setup shared by every e2e test file, which each import this module.
 *
 * The hooks register once, at module load, on mocha's root suite. That puts
 * them after ExTester's own root hook that launches VS Code; hooks passed
 * to mocha as rootHooks would run before it.
 */
import { expect } from "chai";
import { before, VSBrowser } from "vscode-extension-tester";

import { GlobalActions } from "./actions/Global.actions";

/**
 * The size of every VS Code window, local and CI, so layouts match: side bar
 * widths, wrapping and the settings page depend on it. It is VS Code's own
 * default size, which settings.json asks for with
 * "window.newWindowDimensions": "default". ExTester's default, "maximized",
 * gave about 1470x922 on a laptop and had no effect under CI's Xvfb, which
 * has no window manager. ChromeDriver can't resize an Electron window.
 */
export const WINDOW_SIZE = { width: 1200, height: 800 };

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
});
