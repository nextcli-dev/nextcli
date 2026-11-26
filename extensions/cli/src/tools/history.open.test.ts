import { mkdirSync } from "fs";
import path from "path";

import { SqliteDatabase, sqliteHasFts5 } from "@nextcli/context/sqlite";
import { describe, expect, it } from "vitest";

import { getSessionDir, startNewSession } from "../session.js";

import { searchHistoryTool } from "./history.js";

// Its own test file, so its CONTINUE_GLOBAL_DIR has an index nothing opened

describe("SearchHistory's index", () => {
  it("is opened again after another process held it at first use", async () => {
    startNewSession();
    const index = path.join(
      path.dirname(getSessionDir()),
      "index",
      sqliteHasFts5() ? "history.sqlite" : "history-basic.sqlite",
    );
    mkdirSync(path.dirname(index), { recursive: true });
    // Another cn or a VS Code window, in the middle of a write
    const other = await SqliteDatabase.open(index);
    await other.exec("BEGIN EXCLUSIVE; CREATE TABLE held (x)");
    const search = async () => {
      const prepared = await searchHistoryTool.preprocess!({ query: "x" });
      return searchHistoryTool.run(prepared.args);
    };
    try {
      await expect(search()).rejects.toThrow();
    } finally {
      await other.exec("ROLLBACK");
      await other.close();
    }

    expect(await search()).toBe('No match for "x".');
  });
});
