#!/usr/bin/env node
// Spike S1: can sqlite-vector replace LanceDB as nextcli's vector store?
//
// Runs the spike's checks in whatever runtime starts it: plain Node (the CLI)
// or VS Code's Electron with ELECTRON_RUN_AS_NODE=1 (the extension host).
//
//   node spikes/sqlite-vector/check.mjs --ext <path to vector.dylib|.so|.dll> \
//     [--chunks 100000] [--quantize "qtype=INT8"] [--rerank 4] [--out report.json]
//
// 1. load         node:sqlite opens a database and loads the extension.
// 2. retrieval    An index in today's on-disk shape (lance_db_cache and
//                 docs_chunks_cache with JSON vectors, tag_catalog) is migrated
//                 to BLOB vectors without embedding calls, and filtered search
//                 per branch tag and docs site returns the brute-force top-k.
//                 vectordb 0.4.20 is an exact search, so brute force is what
//                 users get today.
// 3. performance  Exact and quantized search at --chunks rows, unfiltered and
//                 filtered, with recall of the quantized scans.
// 4. concurrency  Two processes insert into and search one WAL database.
//
// Exits 1 if a correctness check fails (load, retrieval, quantized recall
// below 0.98, concurrency). Timings are reported, not judged.

import { fork } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIM = 384;
const TOP_K = 10;
const MIN_RECALL = 0.98;
// Options for vector_quantize() (for example "qtype=INT8"); set by --quantize.
let QUANTIZE_OPTIONS = "";
// Quantized scans fetch k * RERANK candidates and re-rank them by exact
// distance; 1 means no re-ranking. Set by --rerank.
let RERANK = 1;
const quantize = (db, table) =>
  QUANTIZE_OPTIONS
    ? db
        .prepare("SELECT vector_quantize(?, 'embedding', ?)")
        .get(table, QUANTIZE_OPTIONS)
    : db.prepare("SELECT vector_quantize(?, 'embedding')").get(table);

// --- shared helpers --------------------------------------------------------

/** mulberry32: deterministic, full 2^32 period, exact in 32-bit integer math. */
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32;
  };
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

/**
 * Hashed bag-of-words embedding: deterministic and lexical, L2-normalized,
 * rounded to float32 as stored vectors are. Stands in for a real model.
 */
function embed(text) {
  const counts = new Map();
  for (const w of text.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  if (counts.size === 0) counts.set(`__nowords__${text}`, 1);
  const v = new Float64Array(DIM);
  for (const [w, n] of counts) {
    const h = sha256(w);
    v[h.readUInt32BE(0) % DIM] += (h[4] & 1 ? 1 : -1) * Math.log1p(n);
  }
  const norm = Math.hypot(...v);
  return Array.from(v, (x) => Math.fround(x / norm));
}

const f32 = (v) => new Uint8Array(new Float32Array(v).buffer);
const sqL2 = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s;
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2);
};
/** Exact re-rank of quantized candidates that carry their BLOB as `e`. */
function rerank(rows, q, k) {
  return rows
    .map((r) => {
      const v = new Float32Array(
        r.e.buffer.slice(r.e.byteOffset, r.e.byteOffset + r.e.byteLength),
      );
      return { id: r.id, d: sqL2(v, q) };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, k);
}
const timeIt = (fn) => {
  const t = performance.now();
  const result = fn();
  return [result, performance.now() - t];
};

async function openDb(file, ext) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { allowExtension: true });
  db.loadExtension(ext);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;");
  return db;
}

function vectorInit(db, table, column = "embedding") {
  db.prepare(
    `SELECT vector_init(?, ?, 'type=FLOAT32,dimension=${DIM},distance=SQUARED_L2')`,
  ).get(table, column);
}

// --- 1. load ---------------------------------------------------------------

async function checkLoad(ext, dir) {
  const db = await openDb(path.join(dir, "load.sqlite"), ext);
  const row = db
    .prepare("SELECT sqlite_version() AS sqlite, vector_version() AS vector")
    .get();
  db.close();
  return { ok: true, ...row };
}

// --- 2. retrieval ----------------------------------------------------------

/** Synthetic source text: Zipf-like draws from a fixed pseudo-word vocabulary. */
function corpus(seed, files, chunksPerFile) {
  const rnd = prng(seed);
  const vocab = Array.from(
    { length: 3000 },
    (_, i) => `w${sha256(String(i)).toString("hex").slice(0, 6)}`,
  );
  const word = () => vocab[Math.floor(vocab.length * rnd() ** 2.5)];
  const text = (n) => Array.from({ length: n }, word).join(" ");
  const out = [];
  for (let f = 0; f < files; f++) {
    const chunks = [];
    for (let c = 0; c < chunksPerFile; c++) {
      chunks.push(text(30 + Math.floor(rnd() * 90)));
    }
    out.push({ path: `src/file${f}.ts`, chunks });
  }
  return { files: out, query: () => text(3 + Math.floor(rnd() * 5)) };
}

/** Writes an index the way today's app does (JSON vectors, vectordb era). */
function writeLegacyIndex(db) {
  const WORKSPACE = "file:///workspace/spike";
  const ARTIFACT = "vectordb::SpikeEmbeddings::hashed-bow-384::512";
  const EMBEDDING_ID = "SpikeEmbeddings::hashed-bow-384::512";
  db.exec(`
    CREATE TABLE lance_db_cache (uuid TEXT PRIMARY KEY, cacheKey TEXT NOT NULL,
      path TEXT NOT NULL, artifact_id TEXT NOT NULL, vector TEXT NOT NULL,
      startLine INTEGER NOT NULL, endLine INTEGER NOT NULL, contents TEXT NOT NULL);
    CREATE TABLE tag_catalog (id INTEGER PRIMARY KEY AUTOINCREMENT, dir STRING NOT NULL,
      branch STRING NOT NULL, artifactId STRING NOT NULL, path STRING NOT NULL,
      cacheKey STRING NOT NULL, lastUpdated INTEGER NOT NULL);
    CREATE TABLE docs_chunks_cache (id INTEGER PRIMARY KEY AUTOINCREMENT,
      starturl TEXT NOT NULL, embeddingsProviderId TEXT NOT NULL, title TEXT NOT NULL,
      path TEXT NOT NULL, content TEXT NOT NULL, startline INTEGER NOT NULL,
      endline INTEGER NOT NULL, vector TEXT NOT NULL, contentHash TEXT NOT NULL);
  `);
  const code = corpus(1, 300, 10);
  const insCache = db.prepare(
    "INSERT INTO lance_db_cache VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insTag = db.prepare(
    "INSERT INTO tag_catalog (dir, branch, artifactId, path, cacheKey, lastUpdated) VALUES (?, ?, ?, ?, ?, 1762300800)",
  );
  const rows = [];
  db.exec("BEGIN");
  for (const [i, file] of code.files.entries()) {
    const filePath = `${WORKSPACE}/${file.path}`;
    const cacheKey = sha256(file.chunks.join("\n")).toString("hex");
    // "main" has every file, "dev" a third of them: two tags share the cache.
    const branches = i % 3 === 0 ? ["main", "dev"] : ["main"];
    for (const b of branches)
      insTag.run(WORKSPACE, b, ARTIFACT, filePath, cacheKey);
    file.chunks.forEach((content, c) => {
      const uuid = sha256(`${filePath}:${c}`).toString("hex").slice(0, 32);
      const vector = embed(content);
      insCache.run(
        uuid,
        cacheKey,
        filePath,
        ARTIFACT,
        JSON.stringify(vector),
        c * 30,
        c * 30 + 29,
        content,
      );
      rows.push({ uuid, branches, vector });
    });
  }
  const docs = corpus(2, 100, 10);
  const insDoc = db.prepare(
    "INSERT INTO docs_chunks_cache (starturl, embeddingsProviderId, title, path, content, startline, endline, vector, contentHash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const sites = [
    "https://docs.example.dev/alpha/",
    "https://docs.example.dev/beta/",
  ];
  const docRows = [];
  for (const [i, file] of docs.files.entries()) {
    const site = sites[i % 2];
    file.chunks.forEach((content, c) => {
      const vector = embed(content);
      const p = `${site}${file.path}`;
      insDoc.run(
        site,
        EMBEDDING_ID,
        "Docs",
        p,
        content,
        c * 30,
        c * 30 + 29,
        JSON.stringify(vector),
        sha256(content).toString("hex"),
      );
      docRows.push({ key: `${p}#${c * 30}`, site, vector });
    });
  }
  db.exec("COMMIT");
  return { ARTIFACT, EMBEDDING_ID, sites, rows, docRows, query: code.query };
}

/**
 * Compares a result list with brute force. Distances must match at every
 * rank; ids must match except inside ties (equal distances may come in any
 * order), where the id sets of the tied group must match instead.
 */
function sameTopK(got, want) {
  if (got.length !== want.length) return false;
  for (let i = 0; i < want.length; i++) {
    if (Math.abs(got[i].d - want[i].d) > 1e-5) return false;
  }
  const groups = new Map();
  want.forEach((w, i) => {
    const key = w.d.toFixed(5);
    if (!groups.has(key)) groups.set(key, [new Set(), new Set()]);
    groups.get(key)[0].add(w.id);
    groups.get(key)[1].add(got[i].id);
  });
  return [...groups.values()].every(
    ([a, b]) => a.size === b.size && [...a].every((x) => b.has(x)),
  );
}

async function checkRetrieval(ext, dir) {
  const db = await openDb(path.join(dir, "index.sqlite"), ext);
  const idx = writeLegacyIndex(db);

  // Migration: JSON text -> float32 BLOB, inside SQLite, no embedder involved.
  let embeddingCalls = 0; // the migration has no embedder to call; kept explicit
  const [, migrateMs] = timeIt(() => {
    db.exec("BEGIN");
    for (const t of ["lance_db_cache", "docs_chunks_cache"]) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN embedding BLOB`);
      db.exec(`UPDATE ${t} SET embedding = vector_as_f32(vector)`);
    }
    db.exec("COMMIT");
  });
  vectorInit(db, "lance_db_cache");
  vectorInit(db, "docs_chunks_cache");
  quantize(db, "lance_db_cache");
  quantize(db, "docs_chunks_cache");

  const codeSql = (scan) => `
    SELECT c.uuid AS id, v.distance AS d, c.embedding AS e FROM ${scan}('lance_db_cache', 'embedding', ?) AS v
    JOIN lance_db_cache c ON c.rowid = v.rowid
    WHERE EXISTS (SELECT 1 FROM tag_catalog t WHERE t.path = c.path AND t.cacheKey = c.cacheKey
                  AND t.branch = ? AND t.artifactId = ?)
    ORDER BY v.distance LIMIT ?`;
  const docsSql = (scan) => `
    SELECT d.path || '#' || d.startline AS id, v.distance AS d, d.embedding AS e
    FROM ${scan}('docs_chunks_cache', 'embedding', ?) AS v
    JOIN docs_chunks_cache d ON d.rowid = v.rowid
    WHERE d.embeddingsProviderId = ? AND d.starturl = ?
    ORDER BY v.distance LIMIT ?`;
  const exactCode = db.prepare(codeSql("vector_full_scan_stream"));
  const quantCode = db.prepare(codeSql("vector_quantize_scan_stream"));
  const exactDocs = db.prepare(docsSql("vector_full_scan_stream"));
  const quantDocs = db.prepare(docsSql("vector_quantize_scan_stream"));

  const brute = (rows, q) =>
    rows
      .map((r) => ({ id: r.uuid ?? r.key, d: sqL2(r.vector, q) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, TOP_K);

  let checked = 0;
  let recallHits = 0;
  let recallTotal = 0;
  const mismatches = [];
  for (let i = 0; i < 20; i++) {
    const text = idx.query();
    const q = embed(text);
    const qb = f32(q);
    for (const branch of ["main", "dev"]) {
      const want = brute(
        idx.rows.filter((r) => r.branches.includes(branch)),
        q,
      );
      const got = exactCode.all(qb, branch, idx.ARTIFACT, BigInt(TOP_K));
      checked++;
      if (!sameTopK(got, want)) mismatches.push(`code ${branch}: "${text}"`);
      const approx = rerank(
        quantCode.all(qb, branch, idx.ARTIFACT, BigInt(TOP_K * RERANK)),
        q,
        TOP_K,
      );
      recallHits += approx.filter((a) =>
        want.some((w) => w.id === a.id),
      ).length;
      recallTotal += want.length;
    }
    for (const site of idx.sites) {
      const want = brute(
        idx.docRows.filter((r) => r.site === site),
        q,
      );
      const got = exactDocs.all(qb, idx.EMBEDDING_ID, site, BigInt(TOP_K));
      checked++;
      if (!sameTopK(got, want)) mismatches.push(`docs ${site}: "${text}"`);
      const approx = rerank(
        quantDocs.all(qb, idx.EMBEDDING_ID, site, BigInt(TOP_K * RERANK)),
        q,
        TOP_K,
      );
      recallHits += approx.filter((a) =>
        want.some((w) => w.id === a.id),
      ).length;
      recallTotal += want.length;
    }
  }
  db.close();
  const quantizedRecall = +(recallHits / recallTotal).toFixed(4);
  return {
    ok:
      mismatches.length === 0 &&
      quantizedRecall >= MIN_RECALL &&
      embeddingCalls === 0,
    codeChunks: idx.rows.length,
    docsChunks: idx.docRows.length,
    migrateMs: +migrateMs.toFixed(1),
    embeddingCalls,
    exactQueriesChecked: checked,
    exactMismatches: mismatches.length,
    firstMismatches: mismatches.slice(0, 3),
    filteredQuantizedRecall: quantizedRecall,
  };
}

// --- 3. performance --------------------------------------------------------

async function checkPerformance(ext, dir, n) {
  const db = await openDb(path.join(dir, "perf.sqlite"), ext);
  db.exec(
    "CREATE TABLE chunks (id INTEGER PRIMARY KEY, tag INTEGER NOT NULL, embedding BLOB)",
  );
  db.exec("CREATE INDEX chunks_tag ON chunks (tag)");
  const rnd = prng(42);
  const r = () => rnd() * 2 - 1;
  const centers = Array.from({ length: 200 }, () =>
    Array.from({ length: DIM }, r),
  );
  const vec = () => {
    const c = centers[Math.floor(rnd() * centers.length)];
    const v = c.map((x) => x + 0.6 * r());
    const norm = Math.hypot(...v);
    return v.map((x) => x / norm);
  };
  const ins = db.prepare("INSERT INTO chunks (tag, embedding) VALUES (?, ?)");
  const [, insertMs] = timeIt(() => {
    db.exec("BEGIN");
    for (let i = 0; i < n; i++) ins.run(i % 10, f32(vec()));
    db.exec("COMMIT");
  });
  vectorInit(db, "chunks");
  const [, quantizeMs] = timeIt(() => quantize(db, "chunks"));
  db.prepare("SELECT vector_quantize_preload('chunks', 'embedding')").get();

  const stmts = {
    exact: db.prepare(
      "SELECT rowid AS id FROM vector_full_scan('chunks', 'embedding', ?, ?)",
    ),
    quantized:
      db.prepare(`SELECT v.rowid AS id, c.embedding AS e FROM vector_quantize_scan('chunks', 'embedding', ?, ?) v
      JOIN chunks c ON c.id = v.rowid`),
    exactFiltered:
      db.prepare(`SELECT c.id FROM vector_full_scan_stream('chunks', 'embedding', ?) v
      JOIN chunks c ON c.id = v.rowid WHERE c.tag = ? ORDER BY v.distance LIMIT ?`),
    quantizedFiltered:
      db.prepare(`SELECT c.id, c.embedding AS e FROM vector_quantize_scan_stream('chunks', 'embedding', ?) v
      JOIN chunks c ON c.id = v.rowid WHERE c.tag = ? ORDER BY v.distance LIMIT ?`),
  };
  const times = {
    exact: [],
    quantized: [],
    exactFiltered: [],
    quantizedFiltered: [],
  };
  const recall = { quantized: [0, 0], quantizedFiltered: [0, 0] };
  for (let i = 0; i < 50; i++) {
    const qv = vec();
    const q = f32(qv);
    const tag = i % 10;
    const res = {};
    for (const [name, stmt] of Object.entries(stmts)) {
      const quantized = name.startsWith("quantized");
      const k = BigInt(quantized ? TOP_K * RERANK : TOP_K);
      const args = name.endsWith("Filtered") ? [q, tag, k] : [q, k];
      const [rows, ms] = timeIt(() => {
        const found = stmt.all(...args);
        return (quantized ? rerank(found, qv, TOP_K) : found).map((x) => x.id);
      });
      res[name] = rows;
      times[name].push(ms);
    }
    for (const [approx, exact] of [
      ["quantized", "exact"],
      ["quantizedFiltered", "exactFiltered"],
    ]) {
      recall[approx][0] += res[approx].filter((id) =>
        res[exact].includes(id),
      ).length;
      recall[approx][1] += res[exact].length;
    }
  }
  db.close();
  const summary = Object.fromEntries(
    Object.entries(times).map(([k, v]) => [
      k,
      { p50: pct(v, 0.5), p95: pct(v, 0.95) },
    ]),
  );
  const recallOf = (k) => +(recall[k][0] / recall[k][1]).toFixed(4);
  return {
    ok:
      recallOf("quantized") >= MIN_RECALL &&
      recallOf("quantizedFiltered") >= MIN_RECALL,
    chunks: n,
    dim: DIM,
    k: TOP_K,
    queries: 50,
    insertMs: +insertMs.toFixed(0),
    quantizeMs: +quantizeMs.toFixed(0),
    searchMs: summary,
    recall: {
      quantized: recallOf("quantized"),
      quantizedFiltered: recallOf("quantizedFiltered"),
    },
  };
}

// --- 4. concurrency --------------------------------------------------------

const WORKER_BATCHES = 200;
const WORKER_BATCH_ROWS = 25;

async function concurrencyWorker(ext, file, name) {
  const db = await openDb(file, ext);
  vectorInit(db, "chunks");
  const ins = db.prepare("INSERT INTO chunks (owner, embedding) VALUES (?, ?)");
  const search = db.prepare(
    "SELECT count(*) AS n FROM vector_full_scan('chunks', 'embedding', ?, ?)",
  );
  const rnd = prng(name === "A" ? 7 : 8);
  let searches = 0;
  for (let b = 0; b < WORKER_BATCHES; b++) {
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < WORKER_BATCH_ROWS; i++) {
      ins.run(name, f32(Array.from({ length: DIM }, rnd)));
    }
    db.exec("COMMIT");
    search.get(f32(Array.from({ length: DIM }, rnd)), 5n);
    searches++;
  }
  db.close();
  process.send({ name, searches });
}

async function checkConcurrency(ext, dir) {
  const file = path.join(dir, "concurrency.sqlite");
  const setup = await openDb(file, ext);
  setup.exec(
    "CREATE TABLE chunks (id INTEGER PRIMARY KEY, owner TEXT, embedding BLOB)",
  );
  setup.close();
  const self = fileURLToPath(import.meta.url);
  const run = (name) =>
    new Promise((resolve, reject) => {
      // Inherits the runtime: under Electron, ELECTRON_RUN_AS_NODE carries over.
      const child = fork(self, ["--worker", name, "--ext", ext, "--db", file]);
      let result;
      child.on("message", (m) => (result = m));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 && result
          ? resolve(result)
          : reject(new Error(`worker ${name} exited ${code}`)),
      );
    });
  const [workers, ms] = await (async () => {
    const t = performance.now();
    const w = await Promise.all([run("A"), run("B")]);
    return [w, performance.now() - t];
  })();
  const db = await openDb(file, ext);
  const rows = Object.fromEntries(
    db
      .prepare("SELECT owner, count(*) AS n FROM chunks GROUP BY owner")
      .all()
      .map((r) => [r.owner, r.n]),
  );
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  db.close();
  const expected = WORKER_BATCHES * WORKER_BATCH_ROWS;
  return {
    ok: rows.A === expected && rows.B === expected && integrity === "ok",
    rows,
    expectedPerWorker: expected,
    searches: workers.map((w) => w.searches),
    integrity,
    ms: +ms.toFixed(0),
  };
}

// --- main ------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    ext: null,
    chunks: 100_000,
    out: null,
    worker: null,
    db: null,
    quantize: "",
    rerank: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!(key in opts)) throw new Error(`Unknown argument: ${argv[i]}`);
    opts[key] =
      key === "chunks" || key === "rerank" ? Number(argv[++i]) : argv[++i];
  }
  if (!opts.ext)
    throw new Error("--ext <path to the sqlite-vector library> is required");
  opts.ext = path.resolve(opts.ext);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  QUANTIZE_OPTIONS = opts.quantize;
  RERANK = opts.rerank;
  if (opts.worker) return concurrencyWorker(opts.ext, opts.db, opts.worker);

  const dir = mkdtempSync(path.join(os.tmpdir(), "sqlite-vector-spike-"));
  const report = {
    runtime: {
      platform: `${process.platform}-${process.arch}`,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
    },
    quantize: opts.quantize || "(default)",
    rerank: opts.rerank,
    checks: {},
  };
  const checks = {
    load: () => checkLoad(opts.ext, dir),
    retrieval: () => checkRetrieval(opts.ext, dir),
    performance: () => checkPerformance(opts.ext, dir, opts.chunks),
    concurrency: () => checkConcurrency(opts.ext, dir),
  };
  for (const [name, fn] of Object.entries(checks)) {
    try {
      report.checks[name] = await fn();
    } catch (err) {
      report.checks[name] = { ok: false, error: String(err?.stack ?? err) };
    }
    // Without the extension nothing else can run.
    if (name === "load" && !report.checks.load.ok) break;
  }
  report.ok = Object.values(report.checks).every((c) => c.ok);
  rmSync(dir, { recursive: true, force: true });

  const json = JSON.stringify(report, null, 2);
  if (opts.out) writeFileSync(opts.out, json + "\n");
  console.log(json);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
