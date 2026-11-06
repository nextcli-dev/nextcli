// jsdom 29 depends on ESM-only packages (@exodus/bytes, parse5 8, ...). Node
// 22.12+ can require() ESM, but Jest's own module system can't ("Must use
// import to load ES Module"), so every suite that loads jsdom would fail.
// This bundles jsdom to one CommonJS file, as the extension and CLI builds do,
// and jest.config.js maps `jsdom` to it. Drop it once Jest can require() ESM
// on the Node versions we test with (Node 24.9+).
//
// jest.config.js runs this before Jest starts. It cannot live in globalSetup:
// with --changedSince (as in CI) Jest resolves test dependencies, including
// the `jsdom` mapping, before globalSetup runs.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const coreDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pluginsFile = path.resolve(
  coreDir,
  "../scripts/esbuild-plugins/jsdom.cjs",
);

export const JSDOM_CJS_FILE = path.join(
  coreDir,
  "node_modules/.cache/jsdom-cjs/jsdom.cjs",
);
const STAMP_FILE = path.join(path.dirname(JSDOM_CJS_FILE), "stamp.json");

export async function bundleJsdomForJest() {
  const jsdomDir = path.join(coreDir, "node_modules/jsdom");
  const jsdomEntry = path.join(jsdomDir, "lib/api.js");
  if (!fs.existsSync(jsdomEntry)) {
    return;
  }

  // Rebuild only when jsdom or the plugins change
  const stamp = JSON.stringify({
    jsdom: JSON.parse(
      fs.readFileSync(path.join(jsdomDir, "package.json"), "utf8"),
    ).version,
    plugins: fs.readFileSync(pluginsFile, "utf8").length,
    pluginsMtime: fs.statSync(pluginsFile).mtimeMs,
  });
  if (
    fs.existsSync(JSDOM_CJS_FILE) &&
    fs.existsSync(STAMP_FILE) &&
    fs.readFileSync(STAMP_FILE, "utf8") === stamp
  ) {
    return;
  }

  const { build } = await import("esbuild");
  const { jsdomPlugins, writeXhrSyncWorkerStub } = require(pluginsFile);

  // Jest finds the named exports of a CommonJS file by scanning it, and a
  // bundle of a CommonJS entry hides them. An ESM wrapper makes esbuild list
  // them.
  const names = Object.keys(require(jsdomEntry));
  const source = [
    `import api from ${JSON.stringify(jsdomEntry)};`,
    ...names.map((name) => `export const ${name} = api.${name};`),
    "export default api;",
  ].join("\n");

  await build({
    stdin: { contents: source, resolveDir: coreDir, loader: "js" },
    outfile: JSDOM_CJS_FILE,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    // Optional native canvas, and the worker file for synchronous XHR
    external: ["canvas", "./xhr-sync-worker.js"],
    plugins: jsdomPlugins(),
    logLevel: "error",
  });
  // jsdom resolves the worker next to itself when it loads (see external above)
  writeXhrSyncWorkerStub(
    path.join(path.dirname(JSDOM_CJS_FILE), "xhr-sync-worker.js"),
  );
  fs.writeFileSync(STAMP_FILE, stamp);
}
