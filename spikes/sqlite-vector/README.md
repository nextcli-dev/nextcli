# Spike S1: sqlite-vector instead of LanceDB

Throwaway branch. Decides whether Phase 5 of the dependency upgrade moves
nextcli's vectors into SQLite with
[sqlite-vector](https://github.com/sqliteai/sqlite-vector) (Apache-2.0) and
drops `vectordb`, `@lancedb/*` and `apache-arrow`.

`check.mjs` runs in plain Node (the CLI) or in VS Code's Electron with
`ELECTRON_RUN_AS_NODE=1` (the extension host) and checks:

1. **load**: `node:sqlite` opens a database and loads the extension.
2. **retrieval**: an index in today's on-disk shape (`lance_db_cache` and
   `docs_chunks_cache` with JSON vectors, `tag_catalog`) is migrated to BLOB
   vectors inside SQLite with no embedding calls; filtered search per branch tag
   and docs site must return the brute-force top-k. vectordb 0.4.20 is an exact
   search, so brute force is what users get today.
3. **performance**: exact and quantized search at 100k × 384, unfiltered and
   filtered. Quantized scans fetch `k × --rerank` candidates (default 4) and
   re-rank them by exact distance; recall must be ≥ 0.98.
4. **concurrency**: two processes insert into and search one WAL database.

```bash
node spikes/sqlite-vector/check.mjs --ext <vector.dylib|.so|.dll> [--chunks 100000] [--rerank 4] [--quantize "qtype=UINT8"]
```

The `Spike S1 (sqlite-vector)` workflow runs it on darwin-arm64/x64,
linux-x64/arm64 and win32-x64/arm64, under Node and under VS Code 1.101.0 (the
minimum Phase 4 plans). sqlite-vector publishes no Windows arm64 build, so the
workflow builds it from source with MSYS2 clang.

Local findings (darwin-arm64):

- Loads in Node 22.23 and in the extension host of VS Code 1.101 (Electron
  35.5.1), 1.145 and Cursor. Not in VS Code 1.95 (no `node:sqlite`). On macOS
  it must run in `Code Helper (Plugin)`: the main Electron binary rejects a
  library signed by another team.
- Exact filtered search matches brute force on every query.
- Quantized recall without re-ranking: 0.99 on real MiniLM vectors of this repo
  (4,000 chunks) but 0.90 on sparse hashed vectors; with 2–4× re-ranking it is
  1.0 on both.
- Filtering by tag or site through `vector_*_scan_stream` scores every row, so
  filtered quantized search is no faster than exact. Per-tag tables (as LanceDB
  has today) would keep the quantized speed.
- `node:sqlite` binds JS numbers as REAL; pass `k` as a BigInt.
