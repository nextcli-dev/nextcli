import * as fs from "fs";
import * as path from "path";

import { expect } from "chai";
import { beforeEach } from "vscode-extension-tester";

import "../Baseline";
import { GlobalActions } from "../actions/Global.actions";
import { GUIActions } from "../actions/GUI.actions";
import { DEFAULT_TIMEOUT } from "../constants";
import { EditSelectors } from "../selectors/Edit.selectors";
import { GUISelectors } from "../selectors/GUI.selectors";
import { TestUtils } from "../TestUtils";

/**
 * The agent's edit tools on files with CRLF line endings (#7909), end to
 * end: the EDIT TOOLS MOCK LLM (test-continue/config.json and
 * test-continue-yaml/config.yaml) sends LF tool arguments for
 * single_find_and_replace and then edit_existing_file. Each tool shows
 * its edit as a diff to accept, which the test does, as a user would. The line-ending logic itself is unit-tested in core
 * (executeFindAndReplace, applyCodeBlock) and handler.vitest.ts; this
 * checks a real document saved to disk.
 */
const FIXTURES = path.resolve(GlobalActions.defaultFolder, "edit-fixtures");
const CRLF_FILE = path.join(FIXTURES, "crlf.js");
const CRLF_REWRITE_FILE = path.join(FIXTURES, "crlf-rewrite.js");

describe("Edit tools on CRLF files", () => {
  beforeEach(async function () {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(
      CRLF_FILE,
      "function add(a, b) {\r\n  return a + b;\r\n}\r\n\r\nfunction sub(a, b) {\r\n  return a - b;\r\n}\r\n",
    );
    fs.writeFileSync(
      CRLF_REWRITE_FILE,
      "function mul(a, b) {\r\n  return a * b;\r\n}\r\n\r\nmodule.exports = { mul };\r\n",
    );
  });

  it("edits with LF tool arguments and keeps the files CRLF", async () => {
    let { view } = await GUIActions.open();
    await GUIActions.useModel(view, "EDIT TOOLS MOCK LLM");
    await GUIActions.useMode(view, "Agent");
    await GUIActions.sendMessage({
      view,
      message: "Edit the fixtures",
      inputFieldIndex: 0,
    });

    for (const toolCallId of ["edit_1", "edit_2"]) {
      ({ view } = await GUIActions.open());
      // An edit tool applies its change as a diff right away; accepting the
      // diff is how the user approves it
      const acceptDiff = await TestUtils.waitForSuccess(
        () => EditSelectors.getEditAcceptButton(view),
        DEFAULT_TIMEOUT.MD,
        250,
        `the diff of ${toolCallId}`,
      );
      await acceptDiff.click();
      await TestUtils.waitForSuccess(
        async () => {
          expect(
            await view.findWebElements(EditSelectors.editAcceptButtonLocator),
          ).to.have.length(0);
        },
        DEFAULT_TIMEOUT.MD,
        250,
        `the diff of ${toolCallId} to close`,
      );
    }

    ({ view } = await GUIActions.open());
    await TestUtils.waitForSuccess(
      () => GUISelectors.getThreadMessageByText(view, "EDITS DONE"),
      DEFAULT_TIMEOUT.MD,
      250,
      "the turn after both edits",
    );

    await GlobalActions.runCommand("workbench.action.files.saveAll");
    await TestUtils.waitForSuccess(
      async () => {
        // single_find_and_replace with an LF old_string and new_string
        expect(fs.readFileSync(CRLF_FILE, "utf8")).to.equal(
          "function add(a, b) {\r\n  return a + b;\r\n}\r\n\r\nfunction sub(a, b) {\r\n  // subtract\r\n  return a - b;\r\n}\r\n",
        );
        // edit_existing_file rewriting the whole file with LF code
        expect(fs.readFileSync(CRLF_REWRITE_FILE, "utf8")).to.equal(
          "function mul(a, b) {\r\n  // multiply\r\n  return a * b;\r\n}\r\n\r\nmodule.exports = { mul };\r\n",
        );
      },
      DEFAULT_TIMEOUT.MD,
      250,
      "the edited files on disk",
    );
  });
});
