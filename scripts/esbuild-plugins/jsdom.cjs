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

/**
 * Writes jsdom's synchronous-XHR worker, bundled, to `outfile`. A bundle that
 * contains jsdom resolves "./xhr-sync-worker.js" next to itself when it loads,
 * and starts that file in a worker thread for a synchronous XMLHttpRequest. A
 * plain copy of the file cannot run there: it requires jsdom and jsdom's IDL
 * utilities by paths that only exist inside the jsdom package. So the worker
 * is bundled with jsdom, like the main bundle.
 */
async function buildXhrSyncWorker(esbuild, { jsdomDir, outfile }) {
  await esbuild.build({
    entryPoints: [
      path.join(jsdomDir, "lib/jsdom/living/xhr/xhr-sync-worker.js"),
    ],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    // The worker's own copy of jsdom resolves the worker next to itself too
    external: ["canvas", "./xhr-sync-worker.js"],
    plugins: jsdomPlugins(),
    logLevel: "error",
  });
}

module.exports = { jsdomPlugins, buildXhrSyncWorker };
