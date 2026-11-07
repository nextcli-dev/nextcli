import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  EXTENSIONS,
  delayForAttempt,
  installExtension,
  isTransientMarketplaceError,
  marketplaceArgs,
} = require("./install-e2e-extensions.js");

const gallery503 =
  "Error while installing extension ms-vscode-remote.remote-wsl: Server returned 503\nFailed Installing Extensions: ms-vscode-remote.remote-wsl";

describe("installExtension", () => {
  it("installs the same marketplace extensions the e2e script used to", () => {
    expect(EXTENSIONS).toEqual([
      "ms-vscode-remote.remote-ssh",
      "ms-vscode-remote.remote-containers",
      "ms-vscode-remote.remote-wsl",
    ]);
    expect(marketplaceArgs("ms-vscode-remote.remote-wsl")).toEqual([
      "install-from-marketplace",
      "ms-vscode-remote.remote-wsl",
      "--extensions_dir",
      "./e2e/.test-extensions",
      "--storage",
      "./e2e/storage",
    ]);
  });

  it("treats a gallery 503 as transient and a missing extension as not", () => {
    expect(isTransientMarketplaceError(gallery503)).toBe(true);
    expect(isTransientMarketplaceError("connect ECONNRESET")).toBe(true);
    expect(
      isTransientMarketplaceError(
        "Extension 'ms-vscode-remote.remote-wsl' not found.",
      ),
    ).toBe(false);
  });

  it("backs off and jitters so parallel jobs do not retry together", () => {
    expect(delayForAttempt(1, () => 0)).toBe(2000);
    expect(delayForAttempt(3, () => 0.5)).toBe(8000 + 500);
  });

  it("retries a 503 and then succeeds", () => {
    const run = vi
      .fn()
      .mockReturnValueOnce({ status: 1, output: gallery503 })
      .mockReturnValueOnce({ status: 0, output: "installed" });
    const sleep = vi.fn();

    const result = installExtension("ms-vscode-remote.remote-wsl", {
      run,
      sleep,
      log: vi.fn(),
      delay: () => 2000,
    });

    expect(result).toEqual({ ok: true, status: 0, attempts: 2 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("does not retry a failure that is not a gallery or network error", () => {
    const run = vi.fn().mockReturnValue({
      status: 1,
      output: "Extension 'ms-vscode-remote.remote-wsl' not found.",
    });
    const sleep = vi.fn();

    const result = installExtension("ms-vscode-remote.remote-wsl", {
      run,
      sleep,
      log: vi.fn(),
    });

    expect(result.ok).toBe(false);
    expect(result.transient).toBe(false);
    expect(result.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops after the last transient failure", () => {
    const run = vi.fn().mockReturnValue({ status: 1, output: gallery503 });
    const sleep = vi.fn();

    const result = installExtension("ms-vscode-remote.remote-wsl", {
      run,
      sleep,
      log: vi.fn(),
      attempts: 4,
      delay: (attempt: number) => attempt,
    });

    expect(result).toEqual({
      ok: false,
      status: 1,
      attempts: 4,
      transient: true,
    });
    expect(run).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
