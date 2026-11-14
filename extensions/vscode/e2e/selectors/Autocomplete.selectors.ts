import { By, WebDriver } from "vscode-extension-tester";

export class AutocompleteSelectors {
  private static readonly ghostTextLocator = By.xpath(
    "//span[contains(@class, 'ghost-text-decoration')]",
  );

  public static async getGhostTextContent(driver: WebDriver) {
    return (
      await driver.findElement(AutocompleteSelectors.ghostTextLocator)
    ).getText();
  }

  /**
   * The ghost text on screen, "" if none. A dismissed suggestion can leave
   * an empty decoration span behind, so an element alone doesn't count.
   */
  public static async getVisibleGhostText(driver: WebDriver) {
    const texts: string[] = [];
    for (const element of await driver.findElements(
      AutocompleteSelectors.ghostTextLocator,
    )) {
      try {
        texts.push(await element.getText());
      } catch (e) {
        // Removed between finding and reading it: not on screen
        if ((e as Error)?.name !== "StaleElementReferenceError") throw e;
      }
    }
    return texts.join("");
  }
}
