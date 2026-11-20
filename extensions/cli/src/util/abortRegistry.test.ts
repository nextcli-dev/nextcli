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

  it("keeps a controller registered while a nested registration ends", () => {
    // A turn's summary request runs a nested stream with the same controller
    const controller = new AbortController();
    const unregisterTurn = registerAbortController(controller);
    const unregisterNested = registerAbortController(controller);
    unregisterNested();
    // A second call of the same unregister changes nothing
    unregisterNested();

    abortAll();

    expect(controller.signal.aborted).toBe(true);
    unregisterTurn();
  });

  it("unregisters a controller once every registration ended", () => {
    const controller = new AbortController();
    const unregisterTurn = registerAbortController(controller);
    const unregisterNested = registerAbortController(controller);
    unregisterNested();
    unregisterTurn();

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
