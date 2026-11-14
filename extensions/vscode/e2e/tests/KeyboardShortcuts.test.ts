import { expect } from "chai";
import {
  beforeEach,
  Key,
  TextEditor,
  until,
  VSBrowser,
  WebDriver,
  WebView,
} from "vscode-extension-tester";

import "../Baseline";
import { GlobalActions } from "../actions/Global.actions";
import { GUIActions } from "../actions/GUI.actions";
import { KeyboardShortcutsActions } from "../actions/KeyboardShortcuts.actions";
import { DEFAULT_TIMEOUT } from "../constants";
import { GUISelectors } from "../selectors/GUI.selectors";
import { TestUtils } from "../TestUtils";

describe("Keyboard Shortcuts", () => {
  let driver: WebDriver;
  let editor: TextEditor;
  let view: WebView;

  beforeEach(async function () {
    driver = VSBrowser.instance.driver;
    editor = await GlobalActions.openNewUntitledFile();
  });

  it("Should correctly undo and redo using keyboard shortcuts when writing a chat message", async () => {
    await GUIActions.executeFocusContinueInputShortcut(driver);
    ({ view } = await GUIActions.switchToReactIframe());
    const chatInput = await TestUtils.waitForSuccess(async () => {
      return GUISelectors.getMessageInputFieldAtIndex(view, 0);
    });

    await chatInput.sendKeys("HELLO ");
    await TestUtils.waitForTimeout(DEFAULT_TIMEOUT.XS);

    await chatInput.sendKeys("WORLD ");
    await TestUtils.waitForTimeout(DEFAULT_TIMEOUT.XS);

    await chatInput.sendKeys("HELLO ");
    await TestUtils.waitForTimeout(DEFAULT_TIMEOUT.XS);

    await chatInput.sendKeys("CONTINUE");
    await TestUtils.waitForTimeout(DEFAULT_TIMEOUT.XS);

    await chatInput.sendKeys(TestUtils.osControlKey + "z");
    await driver.wait(
      until.elementTextIs(chatInput, "HELLO WORLD"),
      DEFAULT_TIMEOUT.SM,
    );

    await chatInput.sendKeys(TestUtils.osControlKey + "z");
    await driver.wait(until.elementTextIs(chatInput, ""), DEFAULT_TIMEOUT.SM);

    await chatInput.sendKeys(Key.SHIFT + TestUtils.osControlKey + "z");
    await driver.wait(
      until.elementTextIs(chatInput, "HELLO"),
      DEFAULT_TIMEOUT.SM,
    );

    await chatInput.sendKeys(Key.SHIFT + TestUtils.osControlKey + "z");
    await driver.wait(
      until.elementTextIs(chatInput, "HELLO WORLD"),
      DEFAULT_TIMEOUT.SM,
    );

    await chatInput.sendKeys(Key.SHIFT + TestUtils.osControlKey + "z");
    await driver.wait(
      until.elementTextIs(chatInput, "HELLO WORLD HELLO"),
      DEFAULT_TIMEOUT.SM,
    );

    await chatInput.sendKeys(Key.SHIFT + TestUtils.osControlKey + "z");
    await driver.wait(
      until.elementTextIs(chatInput, "HELLO WORLD HELLO CONTINUE"),
      DEFAULT_TIMEOUT.SM,
    );
  });

  it("Should not create a code block when Cmd+L is pressed on an empty document", async () => {
    expect((await editor.getText()).trim()).to.equal("");

    await GUIActions.executeFocusContinueInputShortcut(driver);

    ({ view } = await GUIActions.switchToReactIframe());

    await TestUtils.expectNoElement(async () => {
      return GUISelectors.getInputBoxCodeBlockAtIndex(view, 0);
    }, DEFAULT_TIMEOUT.XS);
    await GUIActions.executeFocusContinueInputShortcut(driver);
  });

  it("Fresh VS Code window → sidebar closed → cmd+L with no code highlighted → opens sidebar and focuses input → cmd+L closes sidebar", async () => {
    await GUIActions.executeFocusContinueInputShortcut(driver);
    ({ view } = await GUIActions.switchToReactIframe());
    const textInput = await TestUtils.waitForSuccess(() =>
      GUISelectors.getMessageInputFieldAtIndex(view, 0),
    );
    await GUIActions.waitForFocus(driver, textInput, "the chat input");
    expect(await textInput.isDisplayed()).to.equal(true);

    await GUIActions.executeFocusContinueInputShortcut(driver);

    await driver.wait(until.elementIsNotVisible(textInput), DEFAULT_TIMEOUT.XS);
    expect(await textInput.isDisplayed()).to.equal(false);
  });

  it("Send a message → focus code editor (not sidebar) → cmd+L → should focus sidebar and start a new session", async () => {
    await GUIActions.executeFocusContinueInputShortcut(driver);
    ({ view } = await GUIActions.switchToReactIframe());

    const { userMessage: userMessage0 } = TestUtils.generateTestMessagePair(0);

    await GUIActions.sendMessage({
      view,
      message: userMessage0,
      inputFieldIndex: 0,
    });

    await view.switchBack();

    await KeyboardShortcutsActions.HACK__typeWithSelect(editor, "hello");
    // The shortcut is pressed from the code editor, not the GUI
    await GlobalActions.focusEditor(editor);

    await GUIActions.executeFocusContinueInputShortcut(driver);

    ({ view } = await GUIActions.switchToReactIframe());

    const textInput = await TestUtils.waitForSuccess(() =>
      GUISelectors.getMessageInputFieldAtIndex(view, 0),
    );
    await GUIActions.waitForFocus(driver, textInput, "the chat input");

    await GUIActions.executeFocusContinueInputShortcut(driver);

    await driver.wait(until.elementIsNotVisible(textInput), DEFAULT_TIMEOUT.XS);
    expect(await textInput.isDisplayed()).to.equal(false);
  });

  it("Should create a code block when Cmd+L is pressed with text highlighted", async () => {
    const text = "Hello, world!";

    await editor.setText(text);
    await editor.selectText(text);

    await GUIActions.executeFocusContinueInputShortcut(driver);

    ({ view } = await GUIActions.switchToReactIframe());

    const codeBlock = await TestUtils.waitForSuccess(() =>
      GUISelectors.getInputBoxCodeBlockAtIndex(view, 0),
    );
    const codeblockContent = await codeBlock.getAttribute(
      "data-codeblockcontent",
    );

    expect(codeblockContent).to.equal(text);

    await GUIActions.executeFocusContinueInputShortcut(driver);
  });

  // the below 2 skips are skipped because some behaviour from https://github.com/continuedev/continue/pull/6711 was reverted
  it.skip("Should create a code block with the whole file when Cmd+L is pressed on an empty line", async () => {
    const text = "Hello,\n\n\nworld!";

    await editor.setText(text);
    await editor.moveCursor(2, 1); //Move cursor to an empty line

    await GUIActions.executeFocusContinueInputShortcut(driver);

    ({ view } = await GUIActions.switchToReactIframe());

    const codeBlock = await TestUtils.waitForSuccess(() =>
      GUISelectors.getInputBoxCodeBlockAtIndex(view, 0),
    );
    const codeblockContent = await codeBlock.getAttribute(
      "data-codeblockcontent",
    );

    expect(codeblockContent).to.equal(text);
  });

  it.skip("Should create a code block when Cmd+L is pressed on a non-empty line", async () => {
    const text = "Hello, world!";

    await editor.setText(text);
    await editor.moveCursor(1, 7); //Move cursor to the 1st space

    await GUIActions.executeFocusContinueInputShortcut(driver);

    ({ view } = await GUIActions.switchToReactIframe());

    const codeBlock = await TestUtils.waitForSuccess(() =>
      GUISelectors.getInputBoxCodeBlockAtIndex(view, 0),
    );
    const codeblockContent = await codeBlock.getAttribute(
      "data-codeblockcontent",
    );

    expect(codeblockContent).to.equal(text);
  });
});
