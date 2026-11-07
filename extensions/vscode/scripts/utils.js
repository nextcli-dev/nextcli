const fs = require("fs");
const path = require("path");

const ncp = require("ncp").ncp;
const { rimrafSync } = require("rimraf");

const { execCmdSync } = require("../../../scripts/util/index");

const continueDir = path.join(__dirname, "..", "..", "..");

function copyTokenizers() {
  fs.copyFileSync(
    path.join(__dirname, "../../../core/llm/llamaTokenizerWorkerPool.mjs"),
    path.join(__dirname, "../out/llamaTokenizerWorkerPool.mjs"),
  );
  console.log("[info] Copied llamaTokenizerWorkerPool");

  fs.copyFileSync(
    path.join(__dirname, "../../../core/llm/llamaTokenizer.mjs"),
    path.join(__dirname, "../out/llamaTokenizer.mjs"),
  );
  console.log("[info] Copied llamaTokenizer");
}

async function buildGui(isGhAction) {
  // Make sure we are in the right directory
  if (!process.cwd().endsWith("gui")) {
    process.chdir(path.join(continueDir, "gui"));
  }
  if (isGhAction) {
    execCmdSync("npm run build");
  }

  // Copy over the dist folder to the VSCode extension //
  const vscodeGuiPath = path.join("../extensions/vscode/gui");
  fs.mkdirSync(vscodeGuiPath, { recursive: true });
  await new Promise((resolve, reject) => {
    ncp("dist", vscodeGuiPath, (error) => {
      if (error) {
        console.log(
          "Error copying React app build to VSCode extension: ",
          error,
        );
        reject(error);
      } else {
        console.log("Copied gui build to VSCode extension");
        resolve();
      }
    });
  });

  if (!fs.existsSync(path.join("dist", "assets", "index.js"))) {
    throw new Error("gui build did not produce index.js");
  }
  if (!fs.existsSync(path.join("dist", "assets", "index.css"))) {
    throw new Error("gui build did not produce index.css");
  }
}

async function copyTreeSitterWasms() {
  process.chdir(path.join(continueDir, "extensions", "vscode"));
  fs.mkdirSync("out", { recursive: true });

  await new Promise((resolve, reject) => {
    ncp(
      path.join(__dirname, "../../../core/node_modules/tree-sitter-wasms/out"),
      path.join(__dirname, "../out/tree-sitter-wasms"),
      { dereference: true },
      (error) => {
        if (error) {
          console.warn("[error] Error copying tree-sitter-wasm files", error);
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });

  fs.copyFileSync(
    path.join(__dirname, "../../../core/vendor/tree-sitter.wasm"),
    path.join(__dirname, "../out/tree-sitter.wasm"),
  );
  console.log("[info] Copied tree-sitter wasms");
}

async function copyNodeModules() {
  // Copy node_modules for pre-built binaries
  process.chdir(path.join(continueDir, "extensions", "vscode"));

  const NODE_MODULES_TO_COPY = ["@vscode/ripgrep", "workerpool"];
  fs.mkdirSync("out/node_modules", { recursive: true });

  await Promise.all(
    NODE_MODULES_TO_COPY.map(
      (mod) =>
        new Promise((resolve, reject) => {
          fs.mkdirSync(`out/node_modules/${mod}`, { recursive: true });
          ncp(
            `node_modules/${mod}`,
            `out/node_modules/${mod}`,
            { dereference: true },
            function (error) {
              if (error) {
                console.error(`[error] Error copying ${mod}`, error);
                reject(error);
              } else {
                console.log(`[info] Copied ${mod}`);
                resolve();
              }
            },
          );
        }),
    ),
  );

  console.log(`[info] Copied ${NODE_MODULES_TO_COPY.join(", ")}`);
}

async function downloadSqliteBinary(target) {
  console.log("[info] Downloading pre-built sqlite3 binary");
  rimrafSync("../../core/node_modules/sqlite3/build");
  // Single source of truth for sqlite3 prebuilt URLs (version + win32-arm64).
  const { downloadSqlite } = require("./download-copy-sqlite");
  await downloadSqlite(target, "../../core/node_modules/sqlite3/build.tar.gz");
  execCmdSync("cd ../../core/node_modules/sqlite3 && tar -xvzf build.tar.gz");
  fs.unlinkSync("../../core/node_modules/sqlite3/build.tar.gz");
}

async function copySqliteBinary() {
  process.chdir(path.join(continueDir, "extensions", "vscode"));
  console.log("[info] Copying sqlite node binding from core");
  await new Promise((resolve, reject) => {
    ncp(
      path.join(__dirname, "../../../core/node_modules/sqlite3/build"),
      path.join(__dirname, "../out/build"),
      { dereference: true },
      (error) => {
        if (error) {
          console.warn("[error] Error copying sqlite3 files", error);
          reject(error);
        } else {
          resolve();
        }
      },
    );
  });
}

async function downloadRipgrepBinary(target) {
  console.log("[info] Downloading pre-built ripgrep binary");
  rimrafSync("node_modules/@vscode/ripgrep/bin");
  fs.mkdirSync("node_modules/@vscode/ripgrep/bin", { recursive: true });

  const downloadUrl = {
    "darwin-arm64":
      "https://github.com/microsoft/ripgrep-prebuilt/releases/download/v13.0.0-10/ripgrep-v13.0.0-10-aarch64-apple-darwin.tar.gz",
    "linux-arm64":
      "https://github.com/microsoft/ripgrep-prebuilt/releases/download/v13.0.0-10/ripgrep-v13.0.0-10-aarch64-unknown-linux-gnu.tar.gz",
    "win32-arm64":
      "https://github.com/microsoft/ripgrep-prebuilt/releases/download/v13.0.0-10/ripgrep-v13.0.0-10-aarch64-pc-windows-msvc.zip",
    "linux-x64":
      "https://github.com/microsoft/ripgrep-prebuilt/releases/download/v13.0.0-10/ripgrep-v13.0.0-10-x86_64-unknown-linux-musl.tar.gz",
    "darwin-x64":
      "https://github.com/microsoft/ripgrep-prebuilt/releases/download/v13.0.0-10/ripgrep-v13.0.0-10-x86_64-apple-darwin.tar.gz",
    "win32-x64":
      "https://github.com/microsoft/ripgrep-prebuilt/releases/download/v13.0.0-10/ripgrep-v13.0.0-10-x86_64-pc-windows-msvc.zip",
  }[target];

  if (target.startsWith("win")) {
    execCmdSync(
      `curl -L -o node_modules/@vscode/ripgrep/bin/build.zip ${downloadUrl}`,
    );
    execCmdSync("cd node_modules/@vscode/ripgrep/bin && unzip build.zip");
    fs.unlinkSync("node_modules/@vscode/ripgrep/bin/build.zip");
  } else {
    execCmdSync(
      `curl -L -o node_modules/@vscode/ripgrep/bin/build.tar.gz ${downloadUrl}`,
    );
    execCmdSync(
      "cd node_modules/@vscode/ripgrep/bin && tar -xvzf build.tar.gz",
    );
    fs.unlinkSync("node_modules/@vscode/ripgrep/bin/build.tar.gz");
  }
}

async function copyScripts() {
  process.chdir(path.join(continueDir, "extensions", "vscode"));
  console.log("[info] Copying scripts from core");
  fs.copyFileSync(
    path.join(__dirname, "../../../core/util/start_ollama.sh"),
    path.join(__dirname, "../out/start_ollama.sh"),
  );
  console.log("[info] Copied script files");
}

// We can't simply touch one of our files to trigger a rebuild, because
// esbuild doesn't always use modifications times to detect changes -
// for example, if it finds a file changed within the last 3 seconds,
// it will fall back to full-contents-comparison for that file
//
// So to facilitate development workflows, we always include a timestamp string
// in the build
function writeBuildTimestamp() {
  fs.writeFileSync(
    path.join(continueDir, "extensions/vscode", "src/.buildTimestamp.ts"),
    `export default "${new Date().toISOString()}";\n`,
  );
}

module.exports = {
  continueDir,
  buildGui,
  copyTreeSitterWasms,
  copyNodeModules,
  copySqliteBinary,
  downloadSqliteBinary,
  downloadRipgrepBinary,
  copyTokenizers,
  copyScripts,
  writeBuildTimestamp,
};
