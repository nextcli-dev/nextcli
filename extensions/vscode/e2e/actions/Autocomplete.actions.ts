import { expect } from "chai";
import { Key, TextEditor } from "vscode-extension-tester";

import { DEFAULT_TIMEOUT } from "../constants";
import { GlobalActions } from "./Global.actions";
import { AutocompleteSelectors } from "../selectors/Autocomplete.selectors";
import { TestUtils } from "../TestUtils";

export class AutocompleteActions {
  public static async testCompletions(editor: TextEditor) {
    const driver = editor.getDriver();

    const messagePair0 = TestUtils.generateTestMessagePair(0);
    await editor.typeTextAt(1, 1, messagePair0.userMessage);
    await editor.typeTextAt(1, messagePair0.userMessage.length + 1, " ");
    const ghostText0 = await TestUtils.waitForSuccess(
      () => AutocompleteSelectors.getGhostTextContent(driver),
      // The first completion takes longer because Continue needs to load
      DEFAULT_TIMEOUT.XL,
    );
    expect(ghostText0).to.equal(messagePair0.llmResponse);

    await editor.clearText();

    const messagePair1 = TestUtils.generateTestMessagePair(1);
    await editor.typeTextAt(1, 1, messagePair1.userMessage);
    await editor.typeTextAt(1, messagePair1.userMessage.length + 1, " ");
    const ghostText1 = await TestUtils.waitForSuccess(() =>
      AutocompleteSelectors.getGhostTextContent(driver),
    );
    expect(ghostText1).to.equal(messagePair1.llmResponse);
  }

  /**
   * Shows that "Force Autocomplete" fetches a completion by itself. Typing
   * already triggers one, so the test first lets that one arrive (no request
   * is left pending), dismisses it with Escape and checks it stays gone:
   * VS Code asks for no new completion until the text changes. A completion
   * that then appears came from the command.
   */
  public static async forceCompletion(editor: TextEditor) {
    const driver = editor.getDriver();
    const { userMessage, llmResponse } = TestUtils.generateTestMessagePair(2);
    const expectGhostText = async () =>
      expect(await AutocompleteSelectors.getGhostTextContent(driver)).to.equal(
        llmResponse,
      );

    await editor.typeTextAt(1, 1, userMessage);
    await editor.typeTextAt(1, userMessage.length + 1, " ");
    await TestUtils.waitForSuccess(
      expectGhostText,
      // The first completion takes longer because the extension loads
      DEFAULT_TIMEOUT.XL,
      250,
      "the completion typing triggered",
    );

    await driver.actions().sendKeys(Key.ESCAPE).perform();
    await TestUtils.waitForSuccess(
      async () =>
        expect(
          await AutocompleteSelectors.getVisibleGhostText(driver),
        ).to.equal(""),
      DEFAULT_TIMEOUT.SM,
      200,
      "Escape to dismiss the completion",
    );
    // For longer than the autocomplete debounce, nothing comes back by itself
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      expect(
        await AutocompleteSelectors.getVisibleGhostText(driver),
        "a completion came back without the command",
      ).to.equal("");
      await TestUtils.waitForTimeout(200);
    }

    await GlobalActions.runCommand("continue.forceAutocomplete");
    await TestUtils.waitForSuccess(
      expectGhostText,
      DEFAULT_TIMEOUT.MD,
      250,
      "the forced completion",
    );
  }
}
