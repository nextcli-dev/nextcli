import { beforeEach, describe, expect, it, vi } from "vitest";

const showInformationMessage = vi.fn();
const openExternal = vi.fn();

vi.mock("vscode", () => ({
  version: "1.95.0",
  window: {
    showInformationMessage: (...args: any[]) => showInformationMessage(...args),
  },
  env: { openExternal: (...args: any[]) => openExternal(...args) },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
}));

import {
  isOlderThan,
  MINIMUM_VERSION_DOCS_URL,
  showMinimumVersionNotice,
} from "./minimumVersionNotice";

function fakeGlobalContext(shown = false) {
  const values: Record<string, unknown> = {
    hasShownMinimumVsCodeVersionNotice: shown,
  };
  return {
    values,
    get: vi.fn((key: string) => values[key]),
    update: vi.fn((key: string, value: unknown) => {
      values[key] = value;
    }),
  } as any;
}

describe("isOlderThan", () => {
  it.each([
    ["1.95.0", "1.101.0", true],
    ["1.100.3", "1.101.0", true],
    ["1.70.0", "1.101.0", true],
    ["0.99.0", "1.101.0", true],
    ["1.101.0", "1.101.0", false],
    ["1.101.1", "1.101.0", false],
    ["1.128.0", "1.101.0", false],
    ["2.0.0", "1.101.0", false],
    // Compared numerically, not as text: 1.9 is older than 1.101
    ["1.9.0", "1.101.0", true],
    ["1.101", "1.101.0", false],
    ["1.100.0-insider", "1.101.0", true],
    ["1.101.0-insider", "1.101.0", false],
  ])("%s older than %s: %s", (version, minimum, expected) => {
    expect(isOlderThan(version, minimum)).toBe(expected);
  });

  it.each(["", "unknown", "v1", "x.y.z"])(
    "does not treat %j as older",
    (version) => {
      expect(isOlderThan(version, "1.101.0")).toBe(false);
    },
  );
});

describe("showMinimumVersionNotice", () => {
  beforeEach(() => {
    showInformationMessage.mockReset().mockResolvedValue(undefined);
    openExternal.mockReset();
  });

  it("tells users on an older VS Code, once", () => {
    const ctx = fakeGlobalContext();
    showMinimumVersionNotice(ctx, "1.95.0");

    expect(showInformationMessage).toHaveBeenCalledTimes(1);
    const [message, button] = showInformationMessage.mock.calls[0];
    expect(message).toContain("VS Code 1.101");
    expect(message).toContain("VS Code 1.95.0");
    expect(message).toContain("1.6.x");
    expect(button).toBe("Learn more");
    expect(ctx.update).toHaveBeenCalledWith(
      "hasShownMinimumVsCodeVersionNotice",
      true,
    );

    // A second activation stays quiet
    showMinimumVersionNotice(ctx, "1.95.0");
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("stays quiet on VS Code 1.101 and newer", () => {
    const ctx = fakeGlobalContext();
    for (const version of ["1.101.0", "1.128.0", "2.0.0"]) {
      showMinimumVersionNotice(ctx, version);
    }
    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(ctx.update).not.toHaveBeenCalled();
  });

  it("stays quiet if it was already shown", () => {
    showMinimumVersionNotice(fakeGlobalContext(true), "1.95.0");
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it("uses the running VS Code version by default", () => {
    showMinimumVersionNotice(fakeGlobalContext());
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
    expect(showInformationMessage.mock.calls[0][0]).toContain("1.95.0");
  });

  it("opens the docs from 'Learn more' and does nothing when dismissed", async () => {
    showInformationMessage.mockResolvedValueOnce("Learn more");
    showMinimumVersionNotice(fakeGlobalContext(), "1.95.0");
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
    expect(String(openExternal.mock.calls[0][0])).toBe(
      MINIMUM_VERSION_DOCS_URL,
    );

    openExternal.mockReset();
    showInformationMessage.mockResolvedValueOnce(undefined);
    showMinimumVersionNotice(fakeGlobalContext(), "1.95.0");
    await Promise.resolve();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
