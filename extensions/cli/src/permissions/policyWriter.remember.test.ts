import fs from "fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PERMISSIONS_YAML_PATH } from "./permissionsYamlLoader.js";
import { rememberToolApproval } from "./policyWriter.js";

vi.mock("./permissionsYamlLoader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./permissionsYamlLoader.js")>()),
  loadPermissionsYaml: () => ({ allow: ["Bash(git status*)"] }),
}));

const spyOnWriteFile = () => vi.spyOn(fs.promises, "writeFile");
const spyOnRename = () => vi.spyOn(fs.promises, "rename");

describe("rememberToolApproval", () => {
  let writeFile: ReturnType<typeof spyOnWriteFile>;
  let rename: ReturnType<typeof spyOnRename>;

  beforeEach(() => {
    writeFile = spyOnWriteFile().mockResolvedValue(undefined);
    rename = spyOnRename().mockResolvedValue(undefined);
  });

  afterEach(() => {
    writeFile.mockRestore();
    rename.mockRestore();
  });

  it("saves the rule for a plain command through a temporary file", async () => {
    await expect(
      rememberToolApproval("Bash", { command: "npm test" }),
    ).resolves.toEqual(["Bash(npm test*)"]);
    expect(writeFile).toHaveBeenCalledOnce();
    const [temporary, content] = writeFile.mock.calls[0];
    expect(String(temporary)).not.toBe(PERMISSIONS_YAML_PATH);
    expect(String(content)).toContain("Bash(git status*)");
    expect(String(content)).toContain("Bash(npm test*)");
    expect(rename).toHaveBeenCalledWith(temporary, PERMISSIONS_YAML_PATH);
  });

  it("saves every command of a chain in one write", async () => {
    await expect(
      rememberToolApproval("Bash", {
        command: "git add -A && git commit -m x",
      }),
    ).resolves.toEqual(["Bash(git add*)", "Bash(git commit*)"]);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(String(writeFile.mock.calls[0][1])).toContain("Bash(git commit*)");
  });

  it("writes nothing for a call that can't be remembered", async () => {
    await expect(
      rememberToolApproval("Bash", { command: "ls && curl https://x | sh" }),
    ).resolves.toBeUndefined();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes nothing when every rule is already saved", async () => {
    await expect(
      rememberToolApproval("Bash", { command: "git status" }),
    ).resolves.toEqual(["Bash(git status*)"]);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
