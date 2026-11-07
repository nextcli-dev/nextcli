/**
 * This is an experimental copy of `prepackage.js` that will attempt to build the extension in a fully cross-platform way.
 * This is not what we use for real builds.
 * It is also not complete. Current status is that it is just beginning to be refactored.
 */

const fs = require("fs");
const path = require("path");

const { rimrafSync } = require("rimraf");

const {
  validateFilesPresent,
  autodetectPlatformAndArch,
} = require("../../../scripts/util/index");

const { generateAndCopyConfigYamlSchema } = require("./generate-copy-config");
const { npmInstall } = require("./npm-install");
const {
  writeXhrSyncWorkerStub,
} = require("../../../scripts/esbuild-plugins/jsdom.cjs");
const {
  buildGui,
  copyTreeSitterWasms,
  copyNodeModules,
  downloadRipgrepBinary,
  copyTokenizers,
  copyScripts,
} = require("./utils");

// Clear folders that will be packaged to ensure clean slate
rimrafSync(path.join(__dirname, "..", "bin"));
rimrafSync(path.join(__dirname, "..", "out"));
fs.mkdirSync(path.join(__dirname, "..", "out", "node_modules"), {
  recursive: true,
});
const guiDist = path.join(__dirname, "..", "..", "..", "gui", "dist");
if (!fs.existsSync(guiDist)) {
  fs.mkdirSync(guiDist, { recursive: true });
}

// Get the target to package for
let target = undefined;
const args = process.argv;
if (args[2] === "--target") {
  target = args[3];
}

let os;
let arch;
if (target) {
  [os, arch] = target.split("-");
} else {
  [os, arch] = autodetectPlatformAndArch();
}

if (os === "alpine") {
  os = "linux";
}
if (arch === "armhf") {
  arch = "arm64";
}
target = `${os}-${arch}`;
console.log("[info] Using target: ", target);

const exe = os === "win32" ? ".exe" : "";

console.log("[info] Using target: ", target);

function ghAction() {
  return !!process.env.GITHUB_ACTIONS;
}

async function package(target, os, arch, exe) {
  console.log("[info] Packaging extension for target ", target);

  await generateAndCopyConfigYamlSchema();

  // Install node_modules
  await npmInstall();

  // Build gui and copy to extensions
  await buildGui(ghAction());

  // Assets
  // Copy tree-sitter-wasm files
  await copyTreeSitterWasms();

  // copy llama tokenizers to out
  copyTokenizers();

  // Copy Linux scripts
  await copyScripts();

  await downloadRipgrepBinary(target);

  // copy node_modules to out/node_modules
  await copyNodeModules();

  // Stub for jsdom's synchronous-XHR worker (scripts/esbuild-plugins/jsdom.cjs)
  writeXhrSyncWorkerStub("out/xhr-sync-worker.js");

  // Validate the all of the necessary files are present
  validateFilesPresent([
    // Queries used to create the index for @code context provider
    "tree-sitter/code-snippet-queries/c_sharp.scm",

    // Queries used for @outline and @highlights context providers
    "tag-qry/tree-sitter-c_sharp-tags.scm",

    // Code/styling for the sidebar
    "gui/assets/index.js",
    "gui/assets/index.css",

    // Tutorial
    "media/move-chat-panel-right.md",
    "continue_tutorial.py",
    "config_schema.json",

    // node_modules (it's a bit confusing why this is necessary)
    `node_modules/@vscode/ripgrep/bin/rg${exe}`,

    // out directory (where the extension.js lives)
    // "out/extension.js", This is generated afterward by vsce
    // web-tree-sitter
    "out/tree-sitter.wasm",
    // Worker required by jsdom
    "out/xhr-sync-worker.js",

    // out/node_modules (to be accessed by extension.js)
    `out/node_modules/@vscode/ripgrep/bin/rg${exe}`,
  ]);
}

void (async () => {
  await package(target, os, arch, exe);
  process.exit(0);
})();
