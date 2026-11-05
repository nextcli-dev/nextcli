#!/usr/bin/env node
// Builds a search index with today's vectordb 0.4.20, the way nextcli writes
// one, and saves it as a test fixture together with the expected search
// results. Phase 5 of the dependency upgrade opens this fixture with the new
// vector library to prove existing users' indexes still work without
// re-embedding.
//
// Run once, before vectordb is removed:
//   node scripts/regression/generate-lancedb-fixture.mjs
//
// Writes core/test/fixtures/regression/lancedb-legacy/:
//   index/lancedb/      Lance tables (2 codebase tags, 2 docs tables)
//   index/index.sqlite  lance_db_cache, tag_catalog, docs (as the app creates them)
//   golden.json         the embedding recipe, table names and top-k results
//
// Everything is deterministic: embeddings are hashed bag-of-words vectors,
// UUIDs and timestamps derive from content, and the corpus is a fixed list.

import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const requireFromCore = createRequire(path.join(ROOT, "core/package.json"));
const lance = requireFromCore("vectordb");
const sqlite3 = requireFromCore("sqlite3");

const OUT = path.join(ROOT, "core/test/fixtures/regression/lancedb-legacy");
const DIM = 384;
const CHUNK_LINES = 30;
const TOP_K = 5;
const FIXED_TIME = 1762300800; // 2025-11-05T00:00:00Z, seconds, as tag_catalog stores it
const WORKSPACE = "file:///workspace/nextcli";

// The app's embeddingId format: `${className}::${model}::${maxChunkSize}`.
const EMBEDDING_ID = `FixtureEmbeddings::hashed-bow-${DIM}::512`;
const LEGACY_EMBEDDING_ID = `FixtureEmbeddings::hashed-bow-legacy-${DIM}::512`;
const ARTIFACT_ID = `vectordb::${EMBEDDING_ID}`;

// Fixed corpus: real files from this repo, copied into the fixture as rows.
const CODE_FILES = [
  "core/indexing/CodebaseIndexer.ts",
  "core/indexing/LanceDbIndex.ts",
  "core/indexing/refreshIndex.ts",
  "core/indexing/walkDir.ts",
  "core/indexing/utils.ts",
  "core/indexing/types.ts",
  "core/indexing/FullTextSearchCodebaseIndex.ts",
  "core/indexing/CodeSnippetsIndex.ts",
  "core/indexing/chunk/ChunkCodebaseIndex.ts",
  "core/indexing/chunk/chunk.ts",
  "core/indexing/chunk/basic.ts",
  "core/indexing/chunk/code.ts",
  "core/indexing/docs/DocsService.ts",
  "core/indexing/docs/migrations.ts",
  "core/indexing/docs/article.ts",
  "core/indexing/docs/crawlers/CheerioCrawler.ts",
  "core/indexing/docs/crawlers/ChromiumCrawler.ts",
  "core/indexing/docs/crawlers/GitHubCrawler.ts",
  "core/autocomplete/util/AutocompleteLruCache.ts",
  "core/data/devdataSqlite.ts",
  "core/util/paths.ts",
  "core/context/providers/JiraIssuesContextProvider/JiraClient.ts",
  "core/context/providers/DatabaseContextProvider.ts",
  "core/context/providers/URLContextProvider.ts",
  "core/llm/llms/TransformersJsEmbeddingsProvider.ts",
  "packages/fetch/src/fetch.ts",
];
// The "dev" branch tag holds a subset, so two codebase tables exist.
const DEV_BRANCH_FILES = CODE_FILES.slice(0, 10);

const DOCS_SITES = [
  {
    startUrl: "https://docs.example.dev/alpha/",
    title: "Alpha Docs",
    texts: CODE_FILES.slice(0, 8),
  },
  {
    startUrl: "https://docs.example.dev/beta/",
    title: "Beta Docs",
    texts: CODE_FILES.slice(8, 16),
  },
];

const QUERIES = [
  "how is the lancedb table name built from a tag",
  "sqlite cache table for embeddings vectors",
  "walk the directory and ignore files",
  "delete docs from lance by start url",
  "rename baseurl column migration",
  "full text search index",
  "chunk a document into pieces by size",
  "crawl a website with cheerio",
  "github repository crawler",
  "autocomplete lru cache",
  "jira issue description markdown",
  "database context provider tables",
  "fetch url context provider",
  "transformers js embeddings pipeline",
  "proxy agent for fetch requests",
  "index folder path global dir",
  "tag catalog last updated cache key",
  "retrieve chunks by vector similarity",
  "devdata sqlite logging",
  "code snippets index tree sitter",
];

/**
 * Hashed bag-of-words embedding: lexical, deterministic, L2-normalized.
 * Each distinct word counts log(1 + count) so long chunks don't drown short
 * matches. Text with no words (a chunk of only braces) hashes as one token of
 * its own, because real models never return a zero vector and a zero vector
 * would sit at distance 1 from every query.
 */
export function embed(text) {
  const counts = new Map();
  for (const word of text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  if (counts.size === 0) counts.set(`__nowords__${sha256(text)}`, 1);
  const v = new Float64Array(DIM);
  for (const [word, n] of counts) {
    const h = crypto.createHash("sha256").update(word).digest();
    v[h.readUInt32BE(0) % DIM] += (h[4] & 1 ? 1 : -1) * Math.log1p(n);
  }
  const norm = Math.hypot(...v);
  return Array.from(v, (x) => Math.fround(x / norm));
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** A UUID-shaped id derived from content, so golden results are stable. */
function stableUuid(seed) {
  const h = sha256(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function chunkFile(content) {
  const lines = content.split("\n");
  const chunks = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES) {
    const text = lines.slice(start, start + CHUNK_LINES).join("\n");
    if (text.trim()) {
      chunks.push({
        content: text,
        startLine: start,
        endLine: Math.min(start + CHUNK_LINES, lines.length) - 1,
      });
    }
  }
  return chunks;
}

// tagToString() and LanceDbIndex.tableNameForTag() from core/indexing.
const tableNameForTag = (tag) =>
  `${tag.directory}::${tag.branch}::${tag.artifactId}`.replace(/[^\w-_.]/g, "");
// DocsService.getLanceTableName().
const docsTableName = (embeddingId) =>
  `docs${embeddingId}`.replace(/[^a-zA-Z0-9_.-]/g, "_");

function sqliteExec(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, (err) => (err ? reject(err) : resolve())),
  );
}

async function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true });
  const indexDir = path.join(OUT, "index");
  mkdirSync(indexDir, { recursive: true });

  const conn = await lance.connect(path.join(indexDir, "lancedb"));
  const db = new sqlite3.Database(path.join(indexDir, "index.sqlite"));

  // Schemas exactly as the app creates them.
  await sqliteExec(
    db,
    `CREATE TABLE lance_db_cache (
        uuid TEXT PRIMARY KEY,
        cacheKey TEXT NOT NULL,
        path TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        vector TEXT NOT NULL,
        startLine INTEGER NOT NULL,
        endLine INTEGER NOT NULL,
        contents TEXT NOT NULL
    )`,
  );
  await sqliteExec(
    db,
    `CREATE TABLE tag_catalog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dir STRING NOT NULL,
            branch STRING NOT NULL,
            artifactId STRING NOT NULL,
            path STRING NOT NULL,
            cacheKey STRING NOT NULL,
            lastUpdated INTEGER NOT NULL
        )`,
  );
  await sqliteExec(
    db,
    `CREATE TABLE docs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title STRING NOT NULL,
            startUrl STRING NOT NULL,
            favicon STRING,
            embeddingsProviderId STRING
        )`,
  );

  // --- Codebase tables: one per branch tag, rows shaped like createLanceDbRows().
  const codeTables = [];
  const cached = new Set();
  for (const [branch, files] of [
    ["main", CODE_FILES],
    ["dev", DEV_BRANCH_FILES],
  ]) {
    const tag = { directory: WORKSPACE, branch, artifactId: ARTIFACT_ID };
    const rows = [];
    for (const rel of files) {
      const content = readFileSync(path.join(ROOT, rel), "utf8");
      const filePath = `${WORKSPACE}/${rel}`;
      const cacheKey = sha256(content);
      await sqliteExec(
        db,
        "INSERT INTO tag_catalog (dir, branch, artifactId, path, cacheKey, lastUpdated) VALUES (?, ?, ?, ?, ?, ?)",
        [WORKSPACE, branch, ARTIFACT_ID, filePath, cacheKey, FIXED_TIME],
      );
      for (const chunk of chunkFile(content)) {
        const row = {
          path: filePath,
          cachekey: cacheKey,
          uuid: stableUuid(`${filePath}:${chunk.startLine}`),
          vector: embed(chunk.content),
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          contents: chunk.content,
        };
        rows.push(row);
        // lance_db_cache is shared across tags, keyed by uuid.
        if (!cached.has(row.uuid)) {
          cached.add(row.uuid);
          await sqliteExec(
            db,
            "INSERT INTO lance_db_cache (uuid, cacheKey, path, artifact_id, vector, startLine, endLine, contents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
              row.uuid,
              row.cachekey,
              row.path,
              ARTIFACT_ID,
              JSON.stringify(row.vector),
              row.startLine,
              row.endLine,
              row.contents,
            ],
          );
        }
      }
    }
    const name = tableNameForTag(tag);
    await conn.createTable(name, rows);
    codeTables.push({ name, tag, rows: rows.length });
  }

  // --- Docs table, created the way DocsService.createLanceDocsTable() does it.
  const docsTable = docsTableName(EMBEDDING_ID);
  {
    const table = await conn.createTable(docsTable, [
      {
        title: "mockRowTitle",
        vector: embed("mock"),
        starturl: "",
        content: "",
        path: "",
        startline: 0,
        endline: 0,
      },
    ]);
    await table.delete(`title = 'mockRowTitle'`);
    for (const site of DOCS_SITES) {
      const rows = [];
      for (const rel of site.texts) {
        const content = readFileSync(path.join(ROOT, rel), "utf8");
        const pagePath = `${site.startUrl}${rel.replaceAll("/", "-")}`;
        for (const chunk of chunkFile(content)) {
          rows.push({
            vector: embed(chunk.content),
            starturl: site.startUrl,
            title: site.title,
            content: chunk.content,
            path: pagePath,
            startline: chunk.startLine,
            endline: chunk.endLine,
          });
        }
      }
      await table.add(rows);
      await sqliteExec(
        db,
        "INSERT INTO docs (title, startUrl, favicon, embeddingsProviderId) VALUES (?, ?, ?, ?)",
        [site.title, site.startUrl, null, EMBEDDING_ID],
      );
    }
  }

  // --- A long-time user's docs table: created with the old `baseurl` column,
  // then renamed by runLanceMigrations() (alterColumns), so it carries an
  // older schema history.
  const legacyDocsTable = docsTableName(LEGACY_EMBEDDING_ID);
  {
    const site = DOCS_SITES[0];
    const rows = [];
    for (const rel of site.texts.slice(0, 3)) {
      const content = readFileSync(path.join(ROOT, rel), "utf8");
      for (const chunk of chunkFile(content)) {
        rows.push({
          vector: embed(chunk.content),
          baseurl: site.startUrl,
          title: site.title,
          content: chunk.content,
          path: `${site.startUrl}${rel.replaceAll("/", "-")}`,
          startline: chunk.startLine,
          endline: chunk.endLine,
        });
      }
    }
    const table = await conn.createTable(legacyDocsTable, rows);
    await table.alterColumns([{ path: "baseurl", rename: "starturl" }]);
  }

  // --- Golden results: the same queries the app would run.
  const results = [];
  for (const query of QUERIES) {
    const vector = embed(query);
    const entry = { query, code: {}, docs: {} };
    for (const { name } of codeTables) {
      const table = await conn.openTable(name);
      const hits = await table.search(vector).limit(TOP_K).execute();
      entry.code[name] = hits.map((h) => ({
        uuid: h.uuid,
        path: h.path,
        startLine: h.startLine,
        distance: h._distance,
      }));
    }
    const table = await conn.openTable(docsTable);
    for (const site of DOCS_SITES) {
      const hits = await table
        .search(vector)
        .limit(TOP_K)
        .where(`starturl = '${site.startUrl}'`)
        .execute();
      entry.docs[site.startUrl] = hits.map((h) => ({
        path: h.path,
        startline: h.startline,
        distance: h._distance,
      }));
    }
    results.push(entry);
  }

  const legacy = await conn.openTable(legacyDocsTable);
  const schema = async (t) =>
    (await t.schema).fields.map((f) => `${f.name}:${f.type}`);

  await new Promise((resolve, reject) =>
    db.close((err) => (err ? reject(err) : resolve())),
  );

  const golden = {
    generatedWith: { vectordb: "0.4.20", node: process.version },
    embedding: {
      method:
        "hashed bag-of-words: distinct lowercase words /[a-z_][a-z0-9_]*/ with weight log1p(count); no words -> one token '__nowords__' + sha256(text); bucket = uint32BE(sha256(word)[0..4]) % dim; sign = sha256(word)[4] & 1 ? +1 : -1; L2-normalize; Math.fround. See scripts/regression/generate-lancedb-fixture.mjs embed().",
      dim: DIM,
      embeddingId: EMBEDDING_ID,
      legacyEmbeddingId: LEGACY_EMBEDDING_ID,
    },
    workspace: WORKSPACE,
    artifactId: ARTIFACT_ID,
    codeTables,
    docsTable: {
      name: docsTable,
      sites: DOCS_SITES.map(({ startUrl, title }) => ({ startUrl, title })),
      rows: await (await conn.openTable(docsTable)).countRows(),
    },
    legacyDocsTable: {
      name: legacyDocsTable,
      rows: await legacy.countRows(),
      schema: await schema(legacy),
    },
    topK: TOP_K,
    queries: results,
  };
  writeFileSync(
    path.join(OUT, "golden.json"),
    JSON.stringify(golden, null, 2) + "\n",
  );
  console.log(
    `Wrote ${path.relative(ROOT, OUT)}: ${codeTables.map((t) => `${t.rows} rows`).join(", ")} in codebase tables, ` +
      `${golden.docsTable.rows} docs rows, ${golden.legacyDocsTable.rows} legacy docs rows, ${results.length} queries.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
