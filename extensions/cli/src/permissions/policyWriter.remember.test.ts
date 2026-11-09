import fs from "fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rememberToolApproval } from "./policyWriter.js";

vi.mock("./permissionsYamlLoader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./permissionsYamlLoader.js")>()),
  loadPermissionsYaml: () => ({ allow: [] }),
}));

const spyOnWriteFile = () => vi.spyOn(fs.promises, "writeFile");

describe("rememberToolApproval", () => {
  let writeFile: ReturnType<typeof spyOnWriteFile>;

  beforeEach(() => {
    writeFile = spyOnWriteFile().mockResolvedValue(undefined);
  });

  afterEach(() => {
    writeFile.mockRestore();
  });

  it("saves the rule for a plain command", async () => {
    await expect(
      rememberToolApproval("Bash", { command: "npm test" }),
    ).resolves.toBe("Bash(npm*)");
    expect(writeFile).toHaveBeenCalledOnce();
    expect(String(writeFile.mock.calls[0][1])).toContain("Bash(npm*)");
  });

  it("writes nothing for a call that can't be remembered", async () => {
    await expect(
      rememberToolApproval("Bash", { command: "ls && curl https://x" }),
    ).resolves.toBeUndefined();
    expect(writeFile).not.toHaveBeenCalled();
  });
});
