import { expect } from "chai";
import { Key } from "vscode-extension-tester";

import { DEFAULT_TIMEOUT } from "./constants";

export class TestUtils {
  /**
   * Calls `fn` until it resolves or `timeout` passes, then rethrows the last
   * error `fn` threw, prefixed with what was being waited for and how many
   * attempts it took. The error keeps its type, so a chai diff or a WebDriver
   * error name still shows.
   *
   * Only for functions that are safe to repeat: reads and element lookups.
   * Never wrap a click, keystroke or command whose effect may already have
   * happened when it throws.
   */
  public static async waitForSuccess<T>(
    fn: () => Promise<T>,
    timeout: number = DEFAULT_TIMEOUT.MD,
    interval: number = 500,
    description?: string,
  ): Promise<T> {
    const start = Date.now();
    const deadline = start + timeout;
    let attempts = 0;
    let lastError: unknown;

    while (true) {
      attempts++;
      try {
        return await TestUtils.withDeadline(fn(), deadline);
      } catch (e) {
        lastError = e;
      }
      if (Date.now() + interval >= deadline) break;
      await TestUtils.waitForTimeout(interval);
    }

    const prefix = `[waited ${Date.now() - start}ms, ${attempts} attempt${attempts === 1 ? "" : "s"}${description ? `: ${description}` : ""}] `;
    if (lastError instanceof Error) {
      lastError.message = prefix + lastError.message;
      throw lastError;
    }
    throw new Error(prefix + String(lastError));
  }

  /**
   * Rejects when `deadline` passes before `promise` settles. The abandoned
   * WebDriver call keeps running; this only stops the wait from overrunning.
   */
  private static withDeadline<T>(promise: Promise<T>, deadline: number) {
    promise.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error("The attempt was still running at the deadline")),
        Math.max(deadline - Date.now(), 0),
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Fails if `locatorFn` finds the element at any point within `timeout`.
   * Only Selenium's NoSuchElementError counts as "absent"; any other error is
   * rethrown. Call it after a positive wait for the settled page, or it can
   * pass before the element would have appeared.
   */
  public static async expectNoElement<T>(
    locatorFn: () => Promise<T>,
    timeout: number = 1000,
    interval: number = 200,
  ): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let element: T | undefined;
      try {
        element = await locatorFn();
      } catch (e) {
        if ((e as Error)?.name !== "NoSuchElementError") throw e;
      }
      expect(element, "an element that should be absent was found").to.not.be
        .ok;
      await TestUtils.waitForTimeout(interval);
    }
  }

  public static generateTestMessagePair(id: number = 0): {
    userMessage: string;
    llmResponse: string;
  } {
    return {
      userMessage: `TEST_USER_MESSAGE_${id}`,
      llmResponse: `TEST_LLM_RESPONSE_${id}`,
    };
  }

  public static waitForTimeout(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public static get isMacOS(): boolean {
    return process.platform === "darwin";
  }

  public static get osControlKey() {
    return TestUtils.isMacOS ? Key.META : Key.CONTROL;
  }
}
