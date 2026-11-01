import { afterEach, describe, expect, it } from "vitest";

import {
  abortAll,
  registerAbortController,
  resetAbortRegistryForTests,
} from "./abortRegistry.js";

describe("abortRegistry", () => {
  afterEach(() => {
    resetAbortRegistryForTests();
  });

  it("aborts every registered controller", () => {
    const first = new AbortController();
    const second = new AbortController();
    registerAbortController(first);
    registerAbortController(second);

    abortAll();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it("does not abort an unregistered controller", () => {
    const controller = new AbortController();
    const unregister = registerAbortController(controller);
    unregister();

    abortAll();

    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts a controller registered after shutdown began", () => {
    abortAll();

    const controller = new AbortController();
    registerAbortController(controller);

    expect(controller.signal.aborted).toBe(true);
  });
});
