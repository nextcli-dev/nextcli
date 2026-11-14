import { expect } from "chai";
import { beforeEach, Key, WebDriver, WebView } from "vscode-extension-tester";

import "../Baseline";
import { GlobalActions } from "../actions/Global.actions";
import { GUIActions } from "../actions/GUI.actions";
import { DEFAULT_TIMEOUT } from "../constants";
import { GUISelectors } from "../selectors/GUI.selectors";
import { TestUtils } from "../TestUtils";

/**
 * Smoke tests of the chat GUI inside a real VS Code: what needs the
 * webview, keyboard focus or VS Code's commands. The chat behavior itself
 * (deleting and editing messages, tool call approval, status text, rules,
 * input history) is unit-tested in gui/ with Vitest.
 */
describe("GUI", () => {
  let view: WebView;
  let driver: WebDriver;

  beforeEach(async function () {
    ({ view, driver } = await GUIActions.open());
    await GUIActions.useModel(view, "TEST LLM");
  });

  async function waitForReply(text: string) {
    await TestUtils.waitForSuccess(
      () => GUISelectors.getThreadMessageByText(view, text),
      DEFAULT_TIMEOUT.MD,
      250,
      `the reply "${text}"`,
    );
  }

  it("sends a message with Enter and shows the reply", async () => {
    const { userMessage, llmResponse } = TestUtils.generateTestMessagePair(0);
    const input = await GUISelectors.getMainInput(view);
    await input.sendKeys(userMessage, Key.ENTER);
    await waitForReply(llmResponse);
  });

  it("runs an agent tool call and finishes the turn", async () => {
    await GUIActions.useModel(view, "TOOL MOCK LLM");
    await GUIActions.useMode(view, "Agent");
    await (await GUISelectors.getMainInput(view)).sendKeys("Hello", Key.ENTER);

    // view_diff runs without asking; the turn then continues with the
    // model's second message and ends
    await TestUtils.waitForSuccess(
      async () => {
        expect(
          await (await GUISelectors.getToolCallStatusMessage(view)).getText(),
        ).to.include("NextCLI viewed the git diff");
      },
      DEFAULT_TIMEOUT.MD,
      250,
      "the finished view_diff call",
    );
    await TestUtils.waitForSuccess(
      async () => {
        expect(await GUISelectors.getStopStreamingButtons(view)).to.have.length(
          0,
        );
      },
      DEFAULT_TIMEOUT.MD,
      250,
      "the turn to finish",
    );
  });

  it("reopens a session from History and continues it", async () => {
    const first = TestUtils.generateTestMessagePair(1);
    const second = TestUtils.generateTestMessagePair(2);
    await GUIActions.sendMessage({
      view,
      message: first.userMessage,
      inputFieldIndex: 0,
    });
    await waitForReply(first.llmResponse);

    // A session reaches History when another one starts
    await GlobalActions.runCommand("continue.newSession");
    ({ view, driver } = await GUIActions.open());
    await TestUtils.expectNoElement(() =>
      GUISelectors.getThreadMessageByText(view, first.llmResponse),
    );

    await GlobalActions.runCommand("continue.viewHistory");
    ({ view, driver } = await GUIActions.switchToReactIframe());
    const row = await TestUtils.waitForSuccess(
      () => GUISelectors.getNthHistoryTableRow(view, 0),
      DEFAULT_TIMEOUT.MD,
      250,
      "the session in History",
    );
    await row.click();

    await waitForReply(first.llmResponse);
    await GUIActions.sendMessage({
      view,
      message: second.userMessage,
      inputFieldIndex: 1,
    });
    await waitForReply(second.llmResponse);
  });

  it("New Session from History leaves an empty input with focus", async () => {
    const input = await GUISelectors.getMainInput(view);
    await input.sendKeys("Hello");
    expect(await input.getText()).to.equal("Hello");

    await GlobalActions.runCommand("continue.viewHistory");
    await GlobalActions.runCommand("continue.newSession");
    ({ view, driver } = await GUIActions.switchToReactIframe());

    const newInput = await TestUtils.waitForSuccess(
      () => GUISelectors.getMainInput(view),
      DEFAULT_TIMEOUT.MD,
      250,
      "the chat input",
    );
    await GUIActions.waitForFocus(driver, newInput, "the chat input");
    expect(await newInput.getText()).to.equal("");
  });

  it("adds the terminal's contents with @terminal", async () => {
    // Replies with the message it was sent, context included
    await GUIActions.useModel(view, "LAST MESSAGE MOCK LLM");
    const input = await GUISelectors.getMainInput(view);
    await input.sendKeys("@", "terminal");
    // Enter picks the provider, the second Enter sends
    await input.sendKeys(Key.ENTER);
    await input.sendKeys(Key.ENTER);
    await waitForReply("Current terminal contents:");
  });
});
