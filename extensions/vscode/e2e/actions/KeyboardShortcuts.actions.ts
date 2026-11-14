import { Key, TextEditor, WebElement } from "vscode-extension-tester";

export class KeyboardShortcutsActions {
  /**
   * For some reason Selenium-simulated keyboard shortcuts don't perfectly
   * mimic the behavior of real shortcuts unless some text is highlighted first.
   */
  public static async HACK__typeWithSelect(editor: TextEditor, text: string) {
    // On VS Code 1.101 the editor's input element (native-edit-context) is
    // not interactable unless the editor has focus, and it does not after the
    // test used the chat panel. Click the editor first.
    await editor.click();
    await editor.typeText(text);
    await editor.selectText(text);
    await editor.typeText(text);
  }
}
