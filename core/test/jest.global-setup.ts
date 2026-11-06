import fs from "fs";
import path from "path";

import { build } from "esbuild";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { jsdomPlugins } = require("../../scripts/esbuild-plugins/jsdom.cjs");

// Sets up the GLOBAL directory for testing - equivalent to ~/.continue
// IMPORTANT: the CONTINUE_GLOBAL_DIR environment variable is used in utils/paths for getting all local paths
export default async function () {
  await bundleJsdomForJest();

  process.env.CONTINUE_GLOBAL_DIR = path.join(__dirname, ".continue-test");
  if (fs.existsSync(process.env.CONTINUE_GLOBAL_DIR)) {
    fs.rmSync(process.env.CONTINUE_GLOBAL_DIR, {
      recursive: true,
      force: true,
    });
  }
}

// jsdom 29 depends on ESM-only packages (@exodus/bytes, parse5 8, ...). Node
// 22.12+ can require() ESM, but Jest's own module system can't ("Must use
// import to load ES Module"), so every suite that loads jsdom would fail.
// Bundle jsdom to a single CommonJS file here, as the extension and CLI builds
// do, and let jest.config.js map `jsdom` to it. Drop this once Jest can
// require() ESM on the Node versions we test with (Node 24.9+).
export const JSDOM_CJS_FILE = path.join(
  __dirname,
  "../node_modules/.cache/jsdom-cjs/jsdom.cjs",
);

async function bundleJsdomForJest() {
  const jsdomEntry = path.join(__dirname, "../node_modules/jsdom/lib/api.js");
  if (!fs.existsSync(jsdomEntry)) {
    return;
  }
  // Jest finds the named exports of a CommonJS file by scanning it, and a bundle
  // of a CommonJS entry hides them. An ESM wrapper makes esbuild list them.
  const names = Object.keys(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(jsdomEntry) as Record<string, unknown>,
  );
  const source = [
    `import api from ${JSON.stringify(jsdomEntry)};`,
    ...names.map((name) => `export const ${name} = api.${name};`),
    "export default api;",
  ].join("\n");

  await build({
    stdin: { contents: source, resolveDir: __dirname, loader: "js" },
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
  fs.copyFileSync(
    path.join(path.dirname(jsdomEntry), "jsdom/living/xhr/xhr-sync-worker.js"),
    path.join(path.dirname(JSDOM_CJS_FILE), "xhr-sync-worker.js"),
  );
}
