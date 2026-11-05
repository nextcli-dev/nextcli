import { describe, expect, it, vi } from "vitest";

import type { IDE } from "../..";
import { getWorkspaceRcConfigs } from "./loadRcConfigs";

/** An IDE class whose readFile needs `this`, like VsCodeIde */
class TestIde {
  private files: Record<string, string> = {
    "file:///proj/.continuerc.json": '{ "disableIndexing": true }',
  };
  async getWorkspaceDirs() {
    return ["file:///proj", "adt://sys"];
  }
  async listDir(dir: string) {
    if (dir === "adt://sys") {
      throw new Error("Operation not supported for object sys");
    }
    return [[".continuerc.json", 1]];
  }
  async readFile(file: string) {
    return this.files[file];
  }
}

describe("getWorkspaceRcConfigs", () => {
  it("loads other folders' configs when one folder can't be listed", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const configs = await getWorkspaceRcConfigs(
      new TestIde() as unknown as IDE,
    );
    expect(configs).toEqual([{ disableIndexing: true }]);
  });
});
