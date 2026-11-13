import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { VSBrowser, WebView, Workbench } from "vscode-extension-tester";

import { GlobalActions } from "../actions/Global.actions";
import { GUIActions } from "../actions/GUI.actions";
import { DEFAULT_TIMEOUT } from "../constants";
import { GUISelectors } from "../selectors/GUI.selectors";
import { TestUtils } from "../TestUtils";

// Files the EDIT TOOLS MOCK LLM (test-continue/config.json and
// test-continue-yaml/config.yaml) edits, by paths relative to the workspace
const FIXTURES = path.resolve(GlobalActions.defaultFolder, "edit-fixtures");
const CRLF_FILE = path.join(FIXTURES, "crlf.js");
const CRLF_REWRITE_FILE = path.join(FIXTURES, "crlf-rewrite.js");

/** Every line break is CRLF */
function expectCrlfOnly(text: string) {
  expect(text).to.include("\r\n");
  expect(text).not.to.match(/[^\r]\n|\r(?!\n)/);
}

describe("Edit tools on CRLF files", () => {
  let view: WebView;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT.XL * 2);
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(
      CRLF_FILE,
      "function add(a, b) {\r\n  return a + b;\r\n}\r\n\r\nfunction sub(a, b) {\r\n  return a - b;\r\n}\r\n",
    );
    fs.writeFileSync(
      CRLF_REWRITE_FILE,
      "function mul(a, b) {\r\n  return a * b;\r\n}\r\n\r\nmodule.exports = { mul };\r\n",
    );

    await GUIActions.moveContinueToSidebar(VSBrowser.instance.driver);
    await GlobalActions.openTestWorkspace();
    await GlobalActions.clearAllNotifications();
    await GlobalActions.disableNextEdit();
    await GUIActions.toggleGui();
    ({ view } = await GUIActions.switchToReactIframe());
    await GUIActions.selectModelFromDropdown(view, "EDIT TOOLS MOCK LLM");
    await GUIActions.selectModeFromDropdown(view, "Agent");
    // Automatic, so each edit is applied and accepted without a click
    view = await GUIActions.toggleToolPolicy(
      view,
      "single_find_and_replace",
      "Automatic",
    );
    view = await GUIActions.toggleToolPolicy(
      view,
      "edit_existing_file",
      "Automatic",
    );
  });

  after(() => {
    fs.rmSync(FIXTURES, { recursive: true, force: true });
  });

  it("edits with LF tool arguments and keeps the files CRLF", async () => {
    await GUIActions.sendMessage({
      view,
      message: "Edit the fixtures",
      inputFieldIndex: 0,
    });
    await TestUtils.waitForSuccess(
      () => GUISelectors.getThreadMessageByText(view, "EDITS DONE"),
      DEFAULT_TIMEOUT.XL,
    );

    await view.switchBack();
    await new Workbench().executeCommand("File: Save All");

    await TestUtils.waitForSuccess(async () => {
      // single_find_and_replace with an LF old_string and new_string
      const edited = fs.readFileSync(CRLF_FILE, "utf8");
      expect(edited).to.include("  // subtract\r\n  return a - b;");
      expectCrlfOnly(edited);

      // edit_existing_file rewriting the whole file with LF code
      const rewritten = fs.readFileSync(CRLF_REWRITE_FILE, "utf8");
      expect(rewritten).to.equal(
        "function mul(a, b) {\r\n  // multiply\r\n  return a * b;\r\n}\r\n\r\nmodule.exports = { mul };\r\n",
      );
    }, DEFAULT_TIMEOUT.MD);
  }).timeout(DEFAULT_TIMEOUT.XL * 2);
});
