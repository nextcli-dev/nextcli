import { By, WebDriver, WebView } from "vscode-extension-tester";

import { SelectorUtils } from "./SelectorUtils";

export class GUISelectors {
  /** The main chat input's editor (not the inputs of sent messages) */
  public static getMainInput(view: WebView) {
    return view.findWebElement(
      By.css("[data-testid='continue-input-box-main-editor-input'] .tiptap"),
    );
  }

  public static getThreadMessages(view: WebView) {
    return view.findWebElements(By.css(".thread-message"));
  }

  /** Shown while a turn streams; empty when the GUI is idle */
  public static getStopStreamingButtons(view: WebView) {
    return view.findWebElements(
      By.css("[data-testid='stop-streaming-button']"),
    );
  }

  public static getEditAcceptButtons(view: WebView) {
    return view.findWebElements(By.css("[data-testid='edit-accept-button']"));
  }

  /** Buttons of an open GUI dialog with exactly this text */
  public static getDialogButtons(view: WebView, text: string) {
    return view.findWebElements(
      By.xpath(`//button[normalize-space()="${text}"]`),
    );
  }

  public static getMessageInputFields(view: WebView) {
    return view.findWebElements(By.className("tiptap"));
  }

  public static async getMessageInputFieldAtIndex(
    view: WebView,
    index: number,
  ) {
    const elements = await this.getMessageInputFields(view);
    // Throw rather than return undefined, so waitForSuccess retries until
    // the input has rendered
    if (!elements[index]) {
      throw new Error(`No message input at index ${index}`);
    }
    return elements[index];
  }

  public static getAllIframes(driver: WebDriver) {
    return driver.findElements(By.css("iframe"));
  }

  public static getToolCallStatusMessage(view: WebView) {
    return SelectorUtils.getElementByDataTestId(view, "tool-call-title");
  }

  public static getModelDropdownButton(view: WebView) {
    return SelectorUtils.getElementByDataTestId(view, "model-select-button");
  }

  /** The selected model's title in the model button, without the effort or other badges */
  public static getModelDropdownTitle(view: WebView) {
    return view.findWebElement(
      By.css("[data-testid='model-select-button'] > span:first-child"),
    );
  }

  public static getModeDropdownButton(view: WebView) {
    return SelectorUtils.getElementByDataTestId(view, "mode-select-button");
  }

  public static getNthHistoryTableRow(view: WebView, index: number) {
    return SelectorUtils.getElementByDataTestId(view, `history-row-${index}`);
  }

  public static getModelDropdownOption(view: WebView, option: string) {
    return view.findWebElement(
      By.xpath(
        `//*[@data-testid="model-select-menu"]//*[normalize-space(text())="${option}"]`,
      ),
    );
  }

  /** The Model row of the model menu, which opens the model list */
  public static getModelListRow(view: WebView) {
    return view.findWebElements(
      By.xpath(`//*[@data-testid="model-select-menu"]//*[@data-row="models"]`),
    );
  }

  public static getModeDropdownOption(view: WebView, option: string) {
    return view.findWebElement(
      By.xpath(`//*[@role="listbox"]//*[normalize-space(text())="${option}"]`),
    );
  }

  public static getThreadMessageByText(view: WebView, text: string) {
    return view.findWebElement(
      By.xpath(`//*[@class="thread-message"]//*[contains(text(), "${text}")]`),
    );
  }

  public static async getInputBoxCodeBlockAtIndex(
    view: WebView,
    index: number,
  ) {
    const firstInputField = await this.getMessageInputFieldAtIndex(view, index);

    const codeBlockElement = await firstInputField.findElement(
      By.xpath(".//code"),
    );

    return codeBlockElement;
  }
}
