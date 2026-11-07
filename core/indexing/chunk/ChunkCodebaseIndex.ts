import * as path from "path";

import { IContinueServerClient } from "../../continueServer/interface.js";
import { Chunk, IndexTag, IndexingProgressUpdate } from "../../index.js";
import { DatabaseConnection, SqliteDb } from "../refreshIndex.js";
import {
  IndexResultType,
  MarkCompleteCallback,
  PathAndCacheKey,
  RefreshIndexResults,
  type CodebaseIndex,
} from "../types.js";

import { getUriPathBasename } from "../../util/uri.js";
import { tagToString } from "../utils.js";
import { chunkDocument, shouldChunk } from "./chunk.js";

// How long one chunk-insert transaction may hold the write lock and the
// thread before the next one starts
const INSERT_SLICE_MS = 15;

export class ChunkCodebaseIndex implements CodebaseIndex {
  relativeExpectedTime: number = 1;
  static artifactId = "chunks";
  artifactId: string = ChunkCodebaseIndex.artifactId;

  constructor(
    private readonly readFile: (filepath: string) => Promise<string>,
    private readonly continueServerClient: IContinueServerClient,
    private readonly maxChunkSize: number,
  ) {}

  async *update(
    tag: IndexTag,
    results: RefreshIndexResults,
    markComplete: MarkCompleteCallback,
    repoName: string | undefined,
  ): AsyncGenerator<IndexingProgressUpdate, any, unknown> {
    const db = await SqliteDb.get();
    await this.createTables(db);
    const tagString = tagToString(tag);

    // Check the remote cache
    if (this.continueServerClient.connected) {
      try {
        const keys = results.compute.map(({ cacheKey }) => cacheKey);
        const resp = await this.continueServerClient.getFromIndexCache(
          keys,
          "chunks",
          repoName,
        );

        for (const chunks of Object.values(resp.files)) {
          await this.insertChunks(db, tagString, chunks);
        }
        results.compute = results.compute.filter(
          (item) => !resp.files[item.cacheKey],
        );
      } catch (e) {
        console.error("Failed to fetch from remote cache: ", e);
      }
    }

    let accumulatedProgress = 0;

    if (results.compute.length > 0) {
      const filepath = results.compute[0].path;
      const folderName = path.basename(path.dirname(filepath));

      yield {
        desc: `Chunking files in ${folderName}`,
        status: "indexing",
        progress: accumulatedProgress,
      };
      const chunkLists = await Promise.all(
        results.compute.map((item) => this.packToChunks(item)),
      );
      await this.insertChunksInSlices(
        db,
        tagString,
        results.compute,
        chunkLists,
        markComplete,
      );
    }

    // Add tag
    for (const item of results.addTag) {
      try {
        await db.run(
          `
          INSERT INTO chunk_tags (chunkId, tag)
          SELECT id, ? FROM chunks
          WHERE cacheKey = ?
        `,
          [tagString, item.cacheKey],
        );
      } catch (e: any) {
        if (!e.message.includes("UNIQUE constraint")) {
          // Throw any errors other than duplicate tag
          // Possible the changes were already added by another instance of the extension
          // For example vscode running side by side with intellij
          throw e;
        }
      }
      await markComplete([item], IndexResultType.AddTag);
      accumulatedProgress += 1 / results.addTag.length / 4;
      yield {
        progress: accumulatedProgress,
        desc: `Adding ${getUriPathBasename(item.path)}`,
        status: "indexing",
      };
    }

    // Remove tag
    for (const item of results.removeTag) {
      await db.run(
        `
        DELETE FROM chunk_tags
        WHERE tag = ?
          AND chunkId IN (
            SELECT id FROM chunks
            WHERE cacheKey = ? AND path = ?
          )
      `,
        [tagString, item.cacheKey, item.path],
      );
      await markComplete([item], IndexResultType.RemoveTag);
      accumulatedProgress += 1 / results.removeTag.length / 4;
      yield {
        progress: accumulatedProgress,
        desc: `Removing ${getUriPathBasename(item.path)}`,
        status: "indexing",
      };
    }

    // Delete
    for (const item of results.del) {
      const chunkToDelete = await db.get(
        "SELECT id FROM chunks WHERE cacheKey = ?",
        [item.cacheKey],
      );

      if (chunkToDelete) {
        await db.run("DELETE FROM chunks WHERE id = ?", [chunkToDelete.id]);

        // Delete from chunk_tags
        await db.run("DELETE FROM chunk_tags WHERE chunkId = ?", [
          chunkToDelete.id,
        ]);
      } else {
        console.debug("Chunk to delete wasn't found in the table: ", item.path);
      }

      await markComplete([item], IndexResultType.Delete);
      accumulatedProgress += 1 / results.del.length / 4;
      yield {
        progress: accumulatedProgress,
        desc: `Removing ${getUriPathBasename(item.path)}`,
        status: "indexing",
      };
    }
  }

  private async createTables(db: DatabaseConnection) {
    await db.exec(`CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cacheKey TEXT NOT NULL,
      path TEXT NOT NULL,
      idx INTEGER NOT NULL,
      startLine INTEGER NOT NULL,
      endLine INTEGER NOT NULL,
      content TEXT NOT NULL
    )`);

    // Chunks are looked up by file (the full-text index reads them per file);
    // without this index every lookup scans the whole table
    await db.exec(
      "CREATE INDEX IF NOT EXISTS idx_chunks_path_cacheKey ON chunks (path, cacheKey)",
    );

    await db.exec(`CREATE TABLE IF NOT EXISTS chunk_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag TEXT NOT NULL,
        chunkId INTEGER NOT NULL,
        FOREIGN KEY (chunkId) REFERENCES chunks (id),
        UNIQUE (tag, chunkId)
    )`);
  }

  private async packToChunks(pack: PathAndCacheKey): Promise<Chunk[]> {
    const contents = await this.readFile(pack.path);
    if (!shouldChunk(pack.path, contents)) {
      return [];
    }
    const chunks: Chunk[] = [];
    const chunkParams = {
      filepath: pack.path,
      contents,
      maxChunkSize: this.maxChunkSize,
      digest: pack.cacheKey,
    };
    for await (const c of chunkDocument(chunkParams)) {
      chunks.push(c);
    }
    return chunks;
  }

  /**
   * Inserts files' chunks in short transactions, a few files at a time, and
   * marks each transaction's files complete right after it commits. Each
   * file stays all-or-nothing, and between transactions the event loop gets
   * a turn (node:sqlite is synchronous) and other windows can take the write
   * lock.
   */
  private async insertChunksInSlices(
    db: DatabaseConnection,
    tagString: string,
    items: PathAndCacheKey[],
    chunkLists: Chunk[][],
    markComplete: MarkCompleteCallback,
  ) {
    let next = 0;
    while (next < items.length) {
      const first = next;
      await this.insertChunksTransaction(db, tagString, (insert) => {
        const start = performance.now();
        do {
          for (const chunk of chunkLists[next]) {
            insert(chunk);
          }
          next++;
        } while (
          next < items.length &&
          performance.now() - start < INSERT_SLICE_MS
        );
      });
      await markComplete(items.slice(first, next), IndexResultType.Compute);
    }
  }

  private async insertChunks(
    db: DatabaseConnection,
    tagString: string,
    chunks: Chunk[],
  ) {
    await this.insertChunksTransaction(db, tagString, (insert) => {
      chunks.forEach(insert);
    });
  }

  private async insertChunksTransaction(
    db: DatabaseConnection,
    tagString: string,
    fill: (insert: (chunk: Chunk) => void) => void,
  ) {
    const chunksSQL =
      "INSERT INTO chunks (cacheKey, path, idx, startLine, endLine, content) VALUES (?, ?, ?, ?, ?, ?)";
    const chunkTagsSQL =
      "INSERT INTO chunk_tags (chunkId, tag) VALUES (last_insert_rowid(), ?)";
    try {
      await db.transaction((tx) => {
        fill((c) => {
          tx.run(chunksSQL, [
            c.digest,
            c.filepath,
            c.index,
            c.startLine,
            c.endLine,
            c.content,
          ]);
          tx.run(chunkTagsSQL, [tagString]);
        });
      });
    } catch (err) {
      // Keep the SQLite code (`SQLITE_FULL: ...`) in the message: the indexer
      // matches it to decide whether to offer a rebuild
      throw new Error(
        `error inserting into chunks tables: ${err instanceof Error ? err.message : err}`,
        { cause: err },
      );
    }
  }
}
