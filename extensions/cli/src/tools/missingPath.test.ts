import { describe, expect, it } from "vitest";

import { listFilesTool } from "./listFiles.js";
import { readFileTool } from "./readFile.js";
import { searchCodeTool } from "./searchCode.js";

// A path the model guessed wrong must not read as "the repository is empty"
const MISSING = "This path is missing. Other files can still be read.";
const NO_SUCH_PATH = "does-not-exist/nowhere";

async function errorOf(action: () => Promise<unknown>): Promise<string> {
  try {
    const result = await action();
    return String(result);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("tools given a path that is not on disk", () => {
  it("Read says only that path is missing", async () => {
    const message = await errorOf(() =>
      readFileTool.run({ filepath: `${NO_SUCH_PATH}/file.ts` }),
    );

    expect(message).toContain(MISSING);
  });

  it("List says only that path is missing", async () => {
    const message = await errorOf(() =>
      listFilesTool.preprocess!({ dirpath: NO_SUCH_PATH }),
    );

    expect(message).toContain(MISSING);
  });

  it("Search says only that path is missing", async () => {
    const message = await errorOf(() =>
      searchCodeTool.run({ pattern: "anything", path: NO_SUCH_PATH }),
    );

    expect(message).toContain(MISSING);
  });
});
