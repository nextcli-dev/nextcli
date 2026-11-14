import { expect } from "chai";
import { CodeLens, TextEditor, WebView } from "vscode-extension-tester";

import { DEFAULT_TIMEOUT } from "../constants";
import { EditSelectors } from "../selectors/Edit.selectors";
import { TestUtils } from "../TestUtils";

export class EditActions {
  /** Cmd/Ctrl+I, the Edit shortcut. Focus the editor first. */
  static async invokeEditShortcut(editor: TextEditor) {
    await editor
      .getDriver()
      .actions()
      .keyDown(TestUtils.osControlKey)
      .sendKeys("i")
      .keyUp(TestUtils.osControlKey)
      .perform();
  }

  /**
   * Waits for the GUI's Edit accept button, which shows once the edit has
   * finished streaming. In Edit mode the toolbar shows no stop button.
   */
  static async waitForEditDone(view: WebView) {
    await TestUtils.waitForSuccess(
      () => EditSelectors.getEditAcceptButton(view),
      DEFAULT_TIMEOUT.MD,
      250,
      "the Edit accept button (the edit finished)",
    );
  }

  /** Waits for a CodeLens titled `title` (Accept or Reject) */
  static async waitForCodeLens(
    editor: TextEditor,
    title: string,
  ): Promise<CodeLens> {
    return TestUtils.waitForSuccess(
      async () => {
        const lens = await editor.getCodeLens(title);
        expect(lens, `a "${title}" CodeLens`).to.not.equal(undefined);
        return lens!;
      },
      DEFAULT_TIMEOUT.MD,
      250,
      `the ${title} CodeLens`,
    );
  }

  /** Waits until the editor shows no diff CodeLenses */
  static async waitForNoCodeLenses(editor: TextEditor) {
    await TestUtils.waitForSuccess(
      async () => {
        expect(
          await editor.getCodeLens("Accept"),
          "an Accept CodeLens",
        ).to.equal(undefined);
        expect(
          await editor.getCodeLens("Reject"),
          "a Reject CodeLens",
        ).to.equal(undefined);
      },
      DEFAULT_TIMEOUT.MD,
      250,
      "the diff CodeLenses to go",
    );
  }
}
