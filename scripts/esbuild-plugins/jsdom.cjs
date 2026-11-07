// esbuild plugins that make a bundled jsdom 29 work.
//
// jsdom 29 and its dependencies read data files from disk relative to their own
// location. That works from node_modules but not in a bundle, where the code
// runs from the output folder: the read fails with ENOENT and importing jsdom
// throws at startup. Two places need handling:
//
// 1. jsdom reads its default stylesheet (lib/jsdom/living/css/helpers/
//    computed-style.js reads ../../../browser/default-stylesheet.css). The
//    text is inlined.
// 2. css-tree's ESM build loads JSON data with createRequire(import.meta.url).
//    @asamuzakjp/dom-selector imports that build, while jsdom requires the
//    CommonJS build (plain require() calls, which esbuild can bundle). Every
//    css-tree import resolves to the CommonJS build, which also keeps a single
//    copy of css-tree in the bundle.
//
// Used by the extension build, the CLI build and the Jest jsdom bundle. If a
// jsdom release changes this code, the build fails here with a clear message
// instead of producing a bundle that crashes on startup.
const fs = require("fs");
const path = require("path");

const STYLESHEET_READ =
  /fs\.readFileSync\(\s*path\.resolve\(__dirname, "\.\.\/\.\.\/\.\.\/browser\/default-stylesheet\.css"\),\s*\{ encoding: "utf-8" \}\s*\)/;

const inlineDefaultStylesheet = {
  name: "jsdom-inline-default-stylesheet",
  setup(build) {
    build.onLoad(
      {
        filter:
          /jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]css[\\/]helpers[\\/]computed-style\.js$/,
      },
      async (args) => {
        const source = await fs.promises.readFile(args.path, "utf8");
        if (!STYLESHEET_READ.test(source)) {
          throw new Error(
            `jsdom bundle: ${args.path} no longer reads default-stylesheet.css the way scripts/esbuild-plugins/jsdom.cjs expects. Update the plugin for the new jsdom version.`,
          );
        }
        const dir = path.dirname(args.path);
        const css = await fs.promises.readFile(
          path.resolve(dir, "../../../browser/default-stylesheet.css"),
          "utf8",
        );
        return {
          contents: source.replace(STYLESHEET_READ, JSON.stringify(css)),
          loader: "js",
          resolveDir: dir,
        };
      },
    );
  },
};

const cssTreeCommonJs = {
  name: "jsdom-css-tree-commonjs",
  setup(build) {
    build.onResolve({ filter: /^css-tree$/ }, async (args) => {
      if (args.pluginData === "css-tree-commonjs") {
        return undefined;
      }
      const resolved = await build.resolve("css-tree", {
        kind: "require-call",
        resolveDir: args.resolveDir,
        importer: args.importer,
        pluginData: "css-tree-commonjs",
      });
      if (resolved.errors.length > 0 || !/[\\/]cjs[\\/]/.test(resolved.path)) {
        throw new Error(
          `jsdom bundle: css-tree no longer resolves to its CommonJS build (got ${resolved.path}). Update scripts/esbuild-plugins/jsdom.cjs.`,
        );
      }
      return { path: resolved.path };
    });
  },
};

/** Plugins to add to any esbuild config that bundles jsdom. */
function jsdomPlugins() {
  return [inlineDefaultStylesheet, cssTreeCommonJs];
}

// A bundle that contains jsdom resolves "./xhr-sync-worker.js" next to itself
// when it loads, and starts it in a worker thread only for a synchronous
// XMLHttpRequest made by a page's own scripts. nextcli never runs page scripts
// (every `new JSDOM(html)` keeps jsdom's default runScripts: off) and never
// uses XMLHttpRequest, so instead of jsdom's worker (12 MB once bundled, as it
// needs its own copy of jsdom) a stub answers jsdom's worker protocol with an
// error. A synchronous XHR then fails at once with a clear NetworkError rather
// than hanging until "Sync XHR worker timed out". If nextcli ever runs page
// scripts in jsdom, bundle jsdom's real worker instead.
const XHR_SYNC_WORKER_STUB = `"use strict";
// Stub for jsdom's synchronous-XHR worker: see scripts/esbuild-plugins/jsdom.cjs
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ sharedBuffer, responsePort }) => {
  const int32 = new Int32Array(sharedBuffer);
  Atomics.store(int32, 0, 1); // acknowledge receipt
  Atomics.notify(int32, 0);
  responsePort.postMessage({
    status: 0,
    statusText: "",
    responseURL: "",
    totalReceivedChunkSize: 0,
    responseHeaders: {},
    filteredResponseHeaders: [],
    error: "Synchronous XMLHttpRequest is not supported in NextCLI",
    uploadComplete: true,
  });
  Atomics.store(int32, 1, 1); // response ready
  Atomics.notify(int32, 1);
});
`;

/** Writes the stub for jsdom's synchronous-XHR worker to `outfile`. */
function writeXhrSyncWorkerStub(outfile) {
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  fs.writeFileSync(outfile, XHR_SYNC_WORKER_STUB);
}

module.exports = { jsdomPlugins, writeXhrSyncWorkerStub };
