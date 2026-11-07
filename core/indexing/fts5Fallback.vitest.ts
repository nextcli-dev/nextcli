/**
 * VS Code 1.101 and 1.102 ship a node:sqlite without FTS5. Indexing must skip
 * only the full-text index there, warn once, and still build the others.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../util/sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/sqlite")>()),
  sqliteHasFts5: () => false,
}));

import CodebaseContextProvider from "../context/providers/CodebaseContextProvider";
import CodeContextProvider from "../context/providers/CodeContextProvider";
import { testIde } from "../test/fixtures";
import { CodebaseIndexer } from "./CodebaseIndexer";

function indexerFor(contextProviders: unknown[]) {
  const config = { contextProviders, selectedModelByRole: {} };
  const configHandler: any = {
    loadConfig: async () => ({
      config,
      errors: [],
      configLoadInterrupted: false,
    }),
    onConfigUpdate: () => {},
  };
  return new CodebaseIndexer(configHandler, testIde, undefined, true);
}

describe("indexing without FTS5", () => {
  it("skips only the full-text index and warns once", async () => {
    const showToast = vi
      .spyOn(testIde, "showToast")
      .mockResolvedValue(undefined as any);
    const indexer = indexerFor([
      new CodebaseContextProvider({}),
      new CodeContextProvider({}),
    ]);

    const first = await (indexer as any).getIndexesToBuild();
    await (indexer as any).getIndexesToBuild();

    expect(first.map((i: any) => i.artifactId)).toEqual([
      "chunks",
      "codeSnippets",
    ]);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0][1]).toContain("FTS5");
  });
});
