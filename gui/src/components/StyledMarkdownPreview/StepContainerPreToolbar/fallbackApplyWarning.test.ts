import { describe, expect, it } from "vitest";
import { getFallbackApplyWarning } from "./fallbackApplyWarning";

describe("getFallbackApplyWarning", () => {
  it("warns when the active file is the global config (the incident)", () => {
    expect(
      getFallbackApplyWarning(
        "markdown",
        "file:///Users/me/.continue/config.yaml",
      ),
    ).toContain("NextCLI config file");
  });

  it("warns for a workspace .continue file even with a matching language", () => {
    expect(
      getFallbackApplyWarning(
        "yaml",
        "file:///repo/.continue/agents/main.yaml",
      ),
    ).toContain("NextCLI config file");
  });

  it("warns when the block language doesn't match the file", () => {
    expect(
      getFallbackApplyWarning("markdown", "file:///repo/deploy.yaml"),
    ).toContain("looks like a different language");
  });

  it("allows matching languages and aliases", () => {
    expect(getFallbackApplyWarning("yaml", "file:///repo/ci.yml")).toBe(
      undefined,
    );
    expect(getFallbackApplyWarning("md", "file:///repo/README.md")).toBe(
      undefined,
    );
    expect(getFallbackApplyWarning("typescript", "file:///repo/App.tsx")).toBe(
      undefined,
    );
    expect(getFallbackApplyWarning("python", "file:///repo/main.py")).toBe(
      undefined,
    );
  });

  it("allows generic or missing languages", () => {
    expect(getFallbackApplyWarning(null, "file:///repo/deploy.yaml")).toBe(
      undefined,
    );
    expect(getFallbackApplyWarning("text", "file:///repo/deploy.yaml")).toBe(
      undefined,
    );
  });

  it("allows files without an extension", () => {
    expect(getFallbackApplyWarning("shell", "file:///repo/Makefile")).toBe(
      undefined,
    );
  });
});
