import { describe, expect, it, vi } from "vitest";

import { ChatMessage, ContinueConfig, IDE } from "../..";
import { BaseLLM } from "../../llm";

import { requestFilesFromRepoMap } from "./repoMapRequest";

vi.mock("../../util/generateRepoMap", () => ({
  default: vi.fn(async () => "src/auth.ts\nsrc/token.ts\nsrc/unused.ts"),
}));

vi.mock("../../util/ideUtils", () => ({
  resolveRelativePathInDir: vi.fn(async (filepath: string) =>
    filepath.startsWith("src/") ? `file:///repo/${filepath}` : undefined,
  ),
}));

/** A reasoning model: thinking first, then the answer the prompt asks for */
class FileSelectionModel extends BaseLLM {
  static providerName = "mock";

  constructor(private readonly reply: ChatMessage[]) {
    // A title in a family the repo-map request supports
    super({ model: "gpt-4o", title: "gpt-4o" });
  }

  protected async *_streamChat(): AsyncGenerator<ChatMessage> {
    yield* this.reply;
  }
}

const config = { experimental: {} } as unknown as ContinueConfig;
const ide = {
  readFile: vi.fn(async () => "export const x = 1;\n"),
} as unknown as IDE;

const select = (reply: ChatMessage[]) =>
  requestFilesFromRepoMap(
    new FileSelectionModel(reply),
    config,
    ide,
    "Why does the token expire early?",
  );

describe("requestFilesFromRepoMap", () => {
  it("reads the files listed in the answer, not in the model's thinking", async () => {
    const chunks = await select([
      {
        role: "thinking",
        content: "Maybe <results>\nsrc/unused.ts\n</results> would do.",
      },
      {
        role: "assistant",
        content:
          "token handling</reasoning>\n<results>\nsrc/auth.ts\nsrc/token.ts\n</results>",
      },
    ]);

    expect(chunks.map((c) => c.filepath)).toEqual([
      "file:///repo/src/auth.ts",
      "file:///repo/src/token.ts",
    ]);
  });

  it("returns no files when the list is only in the thinking", async () => {
    // The prompt asks for <results> in the reply itself
    const chunks = await select([
      {
        role: "thinking",
        content: "<results>\nsrc/auth.ts\n</results>",
      },
      { role: "assistant", content: "done</reasoning>\nno list here" },
    ]);

    expect(chunks).toEqual([]);
  });
});
