// Records the frames for the README demo GIFs. Run through record.sh, not the
// regular e2e suite (which only picks up e2e/_output/tests/*.test.js).
import * as fs from "fs";
import * as path from "path";

import {
  By,
  EditorView,
  Key,
  TextEditor,
  VSBrowser,
  WebDriver,
  WebView,
  Workbench,
} from "vscode-extension-tester";

import { GUIActions } from "../actions/GUI.actions";
import { GUISelectors } from "../selectors/GUI.selectors";
import { TestUtils } from "../TestUtils";

const SCENE = process.env.DEMO_SCENE!;
const OUT = process.env.DEMO_OUT!;
const PROJECT = process.env.DEMO_PROJECT!;

type Frame = { file: string; t: number; badge?: string };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

class Recorder {
  frames: Frame[] = [];
  badge: string | undefined;
  notes: Record<string, unknown> = {};

  constructor(
    private driver: WebDriver,
    private dir: string,
  ) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  async snap() {
    const png = await this.driver.takeScreenshot();
    const file = `frame${String(this.frames.length).padStart(4, "0")}.png`;
    fs.writeFileSync(path.join(this.dir, file), png, "base64");
    this.frames.push({ file, t: Date.now(), badge: this.badge });
  }

  async hold(ms: number, every = 250) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await this.snap();
      await sleep(every);
    }
  }

  // Snapshot until isDone(probe()) holds and the probe hasn't changed for stableMs.
  async until(
    probe: () => Promise<string>,
    isDone: (v: string) => boolean,
    {
      stableMs = 1500,
      timeout = 180000,
      every = 150,
      onTick = async () => {},
    } = {},
  ) {
    const start = Date.now();
    let last = "";
    let lastChange = Date.now();
    while (Date.now() - start < timeout) {
      await this.snap();
      await onTick();
      let v = last;
      try {
        v = await probe();
      } catch {}
      if (/Error handling model response/.test(v)) {
        const i = v.indexOf("Error handling");
        throw new Error(`model error: ${v.slice(i, i + 400)}`);
      }
      if (v !== last) {
        last = v;
        lastChange = Date.now();
      }
      if (isDone(v) && Date.now() - lastChange >= stableMs) {
        return v;
      }
      await sleep(every);
    }
    throw new Error(`timed out; last probe: ${last.slice(-500)}`);
  }

  // Shows a keystroke badge (drawn by compose.py) while `fn` runs.
  async withBadge(badge: string, fn: () => Promise<void>, ms = 900) {
    this.badge = badge;
    await this.snap();
    await fn();
    await this.hold(ms, 150);
    this.badge = undefined;
  }

  save() {
    fs.writeFileSync(
      path.join(this.dir, "frames.json"),
      JSON.stringify({ frames: this.frames, notes: this.notes }, null, 1),
    );
  }
}

async function shortcut(driver: WebDriver, key: string) {
  await driver
    .actions()
    .keyDown(TestUtils.osControlKey)
    .sendKeys(key)
    .keyUp(TestUtils.osControlKey)
    .perform();
}

// Inside the React iframe.
async function chatText(driver: WebDriver) {
  return (await driver.executeScript(
    "return document.body.innerText",
  )) as string;
}

// Inside the React iframe: hide the onboarding card a fresh profile shows.
// Marking onboarding complete alone doesn't stop the card from coming back
// later (e.g. after Edit returns to chat), so also close it.
async function dismissOnboarding(driver: WebDriver) {
  await driver.executeScript(`
    localStorage.setItem("onboardingStatus", JSON.stringify("Completed"));
    localStorage.setItem("hasDismissedOnboardingCard", JSON.stringify(true));
    window.dispatchEvent(new CustomEvent("localStorageChange", { detail: { key: "onboardingStatus", value: "Completed" } }));
  `);
  const close = await driver.findElements(
    By.xpath(
      "(//*[normalize-space(text())='API Key']/ancestor::*[@data-testid][1]//*[name()='svg'])[1]/ancestor-or-self::*[self::button or @role='button' or contains(@class,'cursor-pointer')][1]",
    ),
  );
  if (close.length) {
    await close[0].click().catch(() => {});
  }
}

// Inside the React iframe: cycle modes with Cmd+. (ModeSelect's shortcut).
// The mode button's label is hidden at sidebar width, so it can't be clicked by text.
async function setMode(driver: WebDriver, target: string) {
  for (let i = 0; i < 4; i++) {
    const current = (await driver.executeScript(
      `return document.querySelector("[data-testid='mode-select-button']")?.textContent || ""`,
    )) as string;
    if (current.includes(target)) {
      return;
    }
    await driver.executeScript(
      `document.dispatchEvent(new KeyboardEvent("keydown", { key: ".", metaKey: true, ctrlKey: true, bubbles: true }))`,
    );
    await sleep(500);
  }
  throw new Error(`Could not switch to ${target} mode`);
}

// Inside the React iframe: approve a pending tool call only if it just reads
// (files, search, listings). Anything else, such as a terminal command or an
// edit, fails the scene so it can be recorded again.
async function approveReadOnlyToolCall(driver: WebDriver) {
  const accept = await driver.findElements(
    By.css("[data-testid*='accept-tool-call-button']"),
  );
  if (!accept.length) {
    return;
  }
  const text = await chatText(driver);
  if (!/wants to (read|view|search|list|find|look)/i.test(text)) {
    throw new Error(
      "the model asked to run a tool that isn't read-only; record this scene again",
    );
  }
  await accept[0].click().catch(() => {});
}

async function typeInChat(rec: Recorder, view: WebView, text: string) {
  const input = await GUISelectors.getMessageInputFieldAtIndex(view, 0);
  for (const ch of text) {
    await input.sendKeys(ch);
    await rec.snap();
    await sleep(30);
  }
  await rec.hold(300, 150);
  await input.sendKeys(Key.ENTER);
}

async function openFile(
  name: string,
  scrollTo: number,
  cursor: [number, number],
) {
  await VSBrowser.instance.openResources(path.join(PROJECT, name));
  await sleep(1500);
  const editor = new TextEditor();
  // Scroll so `scrollTo` is near the top, then park the cursor.
  await editor.moveCursor(
    Math.min(scrollTo + 60, await editor.getNumberOfLines()),
    1,
  );
  await editor.moveCursor(scrollTo, 1);
  await editor.moveCursor(cursor[0], cursor[1]);
  return editor;
}

// Arrow keys from the parked cursor (line `at`) keep the scroll position;
// moveCursor (Go to Line) would re-center the view mid-recording.
async function selectLines(
  rec: Recorder,
  driver: WebDriver,
  at: number,
  from: number,
  to: number,
) {
  const key = at > from ? Key.UP : Key.DOWN;
  for (let i = 0; i < Math.abs(at - from); i++) {
    await driver.actions().sendKeys(key).perform();
  }
  await driver.actions().sendKeys(Key.HOME).perform();
  await rec.hold(500, 150);
  for (let l = from; l < to; l++) {
    await driver
      .actions()
      .keyDown(Key.SHIFT)
      .sendKeys(Key.DOWN)
      .keyUp(Key.SHIFT)
      .perform();
    await rec.snap();
  }
  await driver
    .actions()
    .keyDown(Key.SHIFT)
    .sendKeys(Key.END)
    .keyUp(Key.SHIFT)
    .perform();
  await rec.snap();
}

describe("README demo", function () {
  this.timeout(15 * 60 * 1000);
  let driver: WebDriver;

  before(async () => {
    driver = VSBrowser.instance.driver;
    await VSBrowser.instance.openResources(PROJECT);
    await sleep(3000);
    await new Workbench().executeCommand(
      "Notifications: Clear All Notifications",
    );
    await GUIActions.moveContinueToSidebar(driver);
    await sleep(1000);
    // Open the panel once to dismiss onboarding and pick the mode, then leave it open.
    await GUIActions.toggleGui();
    await sleep(2000);
    const { view } = await GUIActions.switchToReactIframe();
    await dismissOnboarding(driver);
    if (SCENE === "agent") {
      await setMode(driver, "Agent");
    }
    if (SCENE === "chat" || SCENE === "edit") {
      await setMode(driver, "Chat");
    }
    await view.switchBack();
    await new Workbench().executeCommand(
      "Notifications: Clear All Notifications",
    );
    await new EditorView().closeAllEditors();
    await sleep(1000);
  });

  it(SCENE, async () => {
    const rec = new Recorder(driver, path.join(OUT, SCENE));
    try {
      if (SCENE === "agent") {
        await GUIActions.toggleGui();
        await sleep(800);
        const { view } = await GUIActions.switchToReactIframe();
        await rec.hold(1200);
        await typeInChat(rec, view, "where is the key value cache?");
        rec.notes.answer = await rec.until(
          () => chatText(driver),
          (v) => !/Generating|Stop/.test(v) && v.length > 200,
          { stableMs: 2500, onTick: () => approveReadOnlyToolCall(driver) },
        );
        await rec.hold(2500);
        await view.switchBack();
      }

      if (SCENE === "chat") {
        await openFile("quantize.py", 96, [129, 1]);
        await rec.hold(1000);
        await selectLines(rec, driver, 129, 102, 129);
        await rec.hold(600, 150);
        await rec.withBadge("⌘ L", () => shortcut(driver, "l"));
        const { view } = await GUIActions.switchToReactIframe();
        await typeInChat(rec, view, "explain this code in a couple sentences");
        rec.notes.answer = await rec.until(
          () => chatText(driver),
          (v) => !/Generating/.test(v) && /\.\s*$/m.test(v),
          { stableMs: 2000 },
        );
        await rec.hold(2500);
        await view.switchBack();
      }

      if (SCENE === "edit") {
        await openFile("model.py", 10, [21, 1]);
        await rec.hold(1000);
        await selectLines(rec, driver, 21, 21, 24);
        await rec.hold(1200, 150);
        await rec.withBadge("⌘ I", () => shortcut(driver, "i"));
        const { view } = await GUIActions.switchToReactIframe();
        await typeInChat(rec, view, "improve variable names");
        await rec.until(
          async () => {
            const accept = await driver.findElements(
              By.css("[data-testid='edit-accept-button']"),
            );
            const text = await chatText(driver);
            return accept.length ? "ready:" + text : text;
          },
          (v) => v.startsWith("ready:"),
          { stableMs: 1500 },
        );
        await rec.hold(1500, 200);
        await driver
          .findElement(By.css("[data-testid='edit-accept-button']"))
          .click();
        await view.switchBack();
        // Move the pointer off the panel so no tooltip stays in the last frame.
        await driver.actions().move({ x: 700, y: 650 }).perform();
        await rec.hold(2500);
        rec.notes.result = await new TextEditor().getText();
      }

      if (SCENE === "autocomplete") {
        // record.sh truncates eval.py:264 to `parser.add_argument('--max_seq_length'`.
        // Like the original GIF, show the editor without the chat panel.
        const auxVisible = () =>
          driver.executeScript(
            `const el = document.querySelector(".part.auxiliarybar"); return !!el && el.offsetWidth > 0;`,
          ) as Promise<boolean>;
        if (await auxVisible()) {
          await new Workbench().executeCommand(
            "View: Toggle Secondary Side Bar Visibility",
          );
          await sleep(800);
        }
        if (await auxVisible()) {
          throw new Error("secondary side bar is still visible");
        }
        const editor = await openFile("eval.py", 250, [264, 1]);
        await editor.moveCursor(
          264,
          (await editor.getTextAtLine(264)).length + 1,
        );
        await rec.hold(1200);
        for (const ch of [",", " "]) {
          await driver.actions().sendKeys(ch).perform();
          await rec.snap();
          await sleep(80);
        }
        rec.notes.ghost = await rec.until(
          async () => {
            const spans = await driver.findElements(
              By.xpath("//span[contains(@class, 'ghost-text-decoration')]"),
            );
            const texts = await Promise.all(spans.map((s) => s.getText()));
            return texts.join("");
          },
          (v) => v.length > 5,
          // Ghost text spans re-render between reads, so take the first full reading.
          { stableMs: 0, timeout: 60000 },
        );
        await rec.hold(1200, 150);
        await rec.withBadge("⇥", () =>
          driver.actions().sendKeys(Key.TAB).perform(),
        );
        await rec.hold(2000);
        rec.notes.line = await editor.getTextAtLine(264);
      }
    } finally {
      rec.save();
    }
  });
});
