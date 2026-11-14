// Runs vscode-extension-tester's `extest` with the e2e VS Code version from
// package.json (config.e2eVscodeVersion), so get-vscode, get-chromedriver and
// run-tests always agree on it. A Node script rather than
// `$npm_package_config_...` in the npm script, which cmd.exe does not expand.
//
//   node scripts/extest.js <command> [extest options]
//
// run-tests starts one VS Code instance per test file and config, as CI does,
// so nothing carries over from one file to the next:
//   - TEST_FILE picks one compiled test file; by default all of them run.
//   - CONTINUE_GLOBAL_DIR picks the NextCLI config directory. Without it,
//     E2E_CONFIG=json|yaml|both (default both) runs each file with
//     e2e/test-continue (config.json) and/or e2e/test-continue-yaml.
// Before each instance it removes the config directory's sessions, index and
// dev data, and the files tests wrote into the workspace. After each one it
// copies the logs and new screenshots to e2e/artifacts/<file>-<config>/,
// because the next launch wipes the VS Code logs.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { config } = require("../package.json");

const CONFIG_DIRS = {
  json: "e2e/test-continue",
  yaml: "e2e/test-continue-yaml",
};
const WORKSPACE = "e2e/fixture-workspace";
const STORAGE = "e2e/storage";
const ARTIFACTS = "e2e/artifacts";
const COMPILED_TESTS = "e2e/_output/tests";

const [command, ...options] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/extest.js <command> [extest options]");
  process.exit(1);
}

const cli = path.join(
  path.dirname(require.resolve("vscode-extension-tester/package.json")),
  require("vscode-extension-tester/package.json").bin.extest,
);

function extest(args, env) {
  const result = spawnSync(
    process.execPath,
    [cli, ...args, "--code_version", config.e2eVscodeVersion],
    { stdio: "inherit", env },
  );
  return result.status ?? 1;
}

if (command !== "run-tests") {
  process.exit(extest([command, ...options], process.env));
}

function testFiles() {
  if (process.env.TEST_FILE) return [process.env.TEST_FILE];
  return fs
    .readdirSync(COMPILED_TESTS)
    .filter((f) => f.endsWith(".test.js"))
    .sort()
    .map((f) => `./${COMPILED_TESTS}/${f}`);
}

function configs() {
  if (process.env.CONTINUE_GLOBAL_DIR) {
    const dir = process.env.CONTINUE_GLOBAL_DIR;
    const name =
      Object.keys(CONFIG_DIRS).find((n) => CONFIG_DIRS[n] === dir) ??
      path.basename(dir);
    return [{ name, dir }];
  }
  const which = process.env.E2E_CONFIG || "both";
  const names = which === "both" ? Object.keys(CONFIG_DIRS) : [which];
  for (const name of names) {
    if (!CONFIG_DIRS[name]) {
      console.error(`E2E_CONFIG must be json, yaml or both (got "${which}")`);
      process.exit(1);
    }
  }
  return names.map((name) => ({ name, dir: CONFIG_DIRS[name] }));
}

function removeTestState(configDir) {
  for (const dir of ["index", "sessions", "dev_data"]) {
    fs.rmSync(path.join(configDir, dir), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(WORKSPACE)) {
    if (entry !== "README.md") {
      fs.rmSync(path.join(WORKSPACE, entry), { recursive: true, force: true });
    }
  }
}

function listScreenshotDirs() {
  const dir = path.join(STORAGE, "screenshots");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function saveArtifacts(file, configName, screenshotDirsBefore) {
  const dest = path.join(
    ARTIFACTS,
    `${path.basename(file, ".test.js")}-${configName}`,
  );
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const copy = (from, to) => {
    if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
  };
  copy(path.join(STORAGE, "settings", "logs"), path.join(dest, "logs"));
  copy(
    path.join(STORAGE, "chromedriver.log"),
    path.join(dest, "chromedriver.log"),
  );
  copy(path.join(STORAGE, "test.log"), path.join(dest, "test.log"));
  for (const dir of listScreenshotDirs()) {
    if (!screenshotDirsBefore.includes(dir)) {
      copy(
        path.join(STORAGE, "screenshots", dir),
        path.join(dest, "screenshots", dir),
      );
    }
  }
  return dest;
}

const results = [];
for (const file of testFiles()) {
  for (const { name, dir } of configs()) {
    console.log(`\n=== ${path.basename(file)} with ${name} config (${dir})\n`);
    removeTestState(dir);
    const screenshotDirsBefore = listScreenshotDirs();
    const status = extest(["run-tests", file, ...options], {
      ...process.env,
      NODE_ENV: "e2e",
      CONTINUE_GLOBAL_DIR: dir,
    });
    const artifacts = saveArtifacts(file, name, screenshotDirsBefore);
    results.push({ file: path.basename(file), name, status, artifacts });
  }
}

if (results.length > 1) {
  console.log("\n=== e2e summary");
  for (const r of results) {
    console.log(
      `${r.status === 0 ? "pass" : "FAIL"}  ${r.file} (${r.name})  ${r.artifacts}`,
    );
  }
}
process.exit(results.every((r) => r.status === 0) ? 0 : 1);
