/**
 * End-to-end indexing on node:sqlite: the chunk, full-text and snippet
 * indexes are written through the real CodebaseIndexer, and keyword search
 * finds the files. The unit tests for those indexes are skipped upstream, and
 * this would have caught node:sqlite's foreign-key default breaking every
 * full-text insert.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Tokenizing runs in a worker that the Vitest layout can't load; this test is
// about the database, so count roughly one token per four characters
vi.mock("../llm/countTokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm/countTokens")>()),
  countTokensAsync: async (text: string) => Math.ceil(text.length / 4),
}));

import CodebaseContextProvider from "../context/providers/CodebaseContextProvider";
import CodeContextProvider from "../context/providers/CodeContextProvider";
import FileSystemIde from "../util/filesystem";
import { localPathToUri } from "../util/pathToUri";
import { CodebaseIndexer } from "./CodebaseIndexer";
import { FullTextSearchCodebaseIndex } from "./FullTextSearchCodebaseIndex";
import { SqliteDb } from "./refreshIndex";

const FILES: Record<string, string> = {
  "billing.ts": `export function calculateInvoiceTotal(lines: number[]) {
  return lines.reduce((sum, line) => sum + line, 0);
}
`,
  "shipping.py": `def estimate_shipping_cost(weight_kg):
    return 4.5 + weight_kg * 1.25
`,
  "README.md": "# Store\n\nInvoices and shipping for the demo store.\n",
};

let workspace: string;

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nextcli-index-"));
  for (const [name, content] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(workspace, name), content);
  }
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("indexing on node:sqlite", () => {
  it("builds every index and finds files by keyword", async () => {
    const ide = new FileSystemIde(workspace);
    const dir = localPathToUri(workspace);
    const config = {
      contextProviders: [
        new CodebaseContextProvider({}),
        new CodeContextProvider({}),
      ],
      selectedModelByRole: {},
    };
    const configHandler: any = {
      loadConfig: async () => ({
        config,
        errors: [],
        configLoadInterrupted: false,
      }),
      onConfigUpdate: () => {},
    };
    // No workspace dirs, so the indexer's own run on init has nothing to do
    ide.getWorkspaceDirs = async () => [];
    const indexer = new CodebaseIndexer(configHandler, ide, undefined, false);
    await indexer.initPromise;

    let last: any;
    for await (const update of indexer.refreshDirs(
      [dir],
      new AbortController().signal,
    )) {
      last = update;
    }
    expect(last).toMatchObject({ status: "done" });
    expect(last.warnings ?? []).toEqual([]);

    const db = await SqliteDb.get();
    const indexed = await db.all(
      "SELECT artifactId, count(*) AS files FROM tag_catalog WHERE dir = ? GROUP BY artifactId ORDER BY artifactId",
      dir,
    );
    expect(indexed).toEqual([
      { artifactId: "chunks", files: 3 },
      { artifactId: "codeSnippets", files: 3 },
      { artifactId: "sqliteFts", files: 3 },
    ]);
    // Stored with sqlite3's types
    expect(
      await db.get(
        "SELECT typeof(lastUpdated) AS type FROM tag_catalog WHERE dir = ? LIMIT 1",
        dir,
      ),
    ).toEqual({ type: "integer" });

    const results = await new FullTextSearchCodebaseIndex().retrieve({
      tags: [{ directory: dir, branch: await ide.getBranch(dir) }],
      text: '"InvoiceTotal"',
      n: 5,
      bm25Threshold: 0,
    });
    expect(results.map((r) => path.basename(r.filepath))).toEqual([
      "billing.ts",
    ]);
  }, 60000);
});
